import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

// Auditing commands is not enough: a command is only as safe as the route that
// constructs or executes it. This enumerates every such route and holds each to
// the same properties.
const { SITE_ID } = await loadServerModule('src/server/site-identity.ts');
const read = (relative) => readFile(path.join(repoRoot, relative), 'utf8');

/** Routes that can construct or execute a command. */
const INGRESSES = {
  'src/pages/api/internal/commands.ts': { executes: true, constructs: false, secret: 'COMMAND_HMAC_SECRET' },
  'src/pages/api/v1/commands.ts': { executes: true, constructs: false, secret: 'COMMAND_HMAC_SECRET' },
  'src/pages/api/emergency/news.ts': { executes: true, constructs: true, secret: 'EMERGENCY_NEWS_HMAC_SECRET' },
  'src/pages/api/control/preflight.ts': { executes: false, constructs: false, secret: 'CONTROL_READ_HMAC_SECRET' },
  'src/pages/api/control/commands/[commandId].ts': { executes: false, constructs: false, secret: 'CONTROL_READ_HMAC_SECRET' }
};

/** Every route that touches executeCommand or preflightCommand must be listed. */
test('the audit covers every command-capable route', async () => {
  const routes = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) routes.push(next);
    }
  };
  await walk('src/pages/api');

  const commandCapable = [];
  for (const route of routes) {
    const source = await read(route);
    // Constructs, executes, validates or resolves a command by id.
    if (/executeCommand\(|preflightCommand\(|CommandEnvelope|restToCanonicalCommand\(|CommandId/.test(source)) commandCapable.push(route);
  }

  assert.deepEqual(
    commandCapable.sort(),
    Object.keys(INGRESSES).sort(),
    'a route that can construct or execute a command must be listed in this audit'
  );
});

for (const [route, expected] of Object.entries(INGRESSES)) {
  test(`${route}: authenticates and fails closed without its secret`, async () => {
    const source = await read(route);
    assert.ok(source.includes(expected.secret) || /authorizeControlRead\(/.test(source), `${route} must authenticate`);
    if (/authorizeControlRead\(/.test(source)) return; // the control plane fails closed inside the helper
    assert.match(source, /if \(!secret\)|env\.COMMAND_HMAC_SECRET/, `${route} must not proceed without its secret`);
  });

  test(`${route}: verifies signatures in constant time`, async () => {
    const source = await read(route);
    if (!/x-(command|emergency)-signature/.test(source)) return;
    assert.match(source, /safeEqual|constantTimeEqual/, `${route} must compare signatures in constant time`);
    assert.ok(!/signature\s*!==\s*expected|expected\s*!==\s*signature/.test(source), `${route} must not compare signatures with !==`);
  });

  test(`${route}: bounds signature freshness`, async () => {
    const source = await read(route);
    if (!/x-(command|emergency)-signature/.test(source)) return;
    assert.match(source, /MAX_TIMESTAMP_SKEW_MS|5\s*\*\s*60\s*\*\s*1000/, `${route} must reject stale signatures`);
  });
}

// The defect that made every emergency publication fail: a route describing its
// own ingress in the field that names the site being changed.
test('no ingress constructs a command with a literal or noncanonical targetSite', async () => {
  const offenders = [];
  for (const [route, expected] of Object.entries(INGRESSES)) {
    const source = await read(route);
    for (const [, value] of source.matchAll(/targetSite\s*:\s*(.+)/g)) {
      const assigned = value.trim().replace(/,$/, '');
      if (assigned === 'SITE_ID') continue;
      offenders.push(`${route}: targetSite: ${assigned}`);
    }
    if (expected.constructs) {
      assert.match(source, /targetSite:\s*SITE_ID/, `${route} constructs commands and must use the canonical installation identity`);
      assert.match(source, /from '@\/server\/site-identity'/, `${route} must take that identity from the one canonical module`);
    }
  }
  assert.deepEqual(offenders, [], `an ingress must not name a site of its own:\n${offenders.join('\n')}`);
});

test('no ingress defines its own site identity', async () => {
  const offenders = [];
  for (const route of Object.keys(INGRESSES)) {
    const source = await read(route);
    // A second, independently configured id is exactly what the canonical
    // module exists to prevent.
    if (/(SITE_ID|siteId)\s*=\s*['"]/.test(source)) offenders.push(route);
  }
  assert.deepEqual(offenders, [], `site identity must come from src/server/site-identity.ts:\n${offenders.join('\n')}`);
});

test('the emergency route targets this installation and records its origin separately', async () => {
  const source = await read('src/pages/api/emergency/news.ts');

  assert.match(source, /targetSite:\s*SITE_ID/, 'the emergency route must target the canonical installation');
  assert.ok(!/targetSite:\s*'emergency-sheet'/.test(source), 'the ingress name must not be used as the target site');

  // The origin is still auditable, in the field that means "who asked".
  assert.match(source, /actor:\s*'emergency-sheet'/, 'the emergency origin must still be recorded as the actor');
  assert.match(source, /ruleVersion:\s*RULE_VERSION/, 'and must use the canonical rule version');
});

test('every executing ingress goes through executeCommand, not its own mutation path', async () => {
  for (const [route, expected] of Object.entries(INGRESSES)) {
    if (!expected.executes) continue;
    const source = await read(route);
    assert.match(source, /executeCommand\(/, `${route} must dispatch through executeCommand`);
    assert.ok(!/INSERT INTO |UPDATE .* SET /i.test(source), `${route} must not carry its own mutation SQL`);
  }
});

// Every property the claim lifecycle guarantees is enforced inside
// executeCommand, so every ingress inherits it rather than re-implementing it.
test('the lifecycle guarantees are enforced once, for all ingresses', async () => {
  const source = await read('src/server/commands.ts');
  const body = source.slice(source.indexOf('export async function executeCommand'));

  for (const guarantee of [
    'authorizeMutation(',              // authorization
    'assertCommandTargetsThisSite(',   // canonical target site
    'await commandDigest(cmd)',        // command digest
    'assertRuleVersion(',              // rule version
    'evaluateExistingJob(',            // claim lifecycle / retry behaviour
    'claimCommand(',
    'recordFailure('                   // terminal status
  ]) {
    assert.ok(body.includes(guarantee), `executeCommand must enforce ${guarantee} for every ingress`);
  }
});

test('the emergency command shape satisfies the envelope', async () => {
  const { CommandEnvelope } = await loadServerModule('src/server/command-schema.ts');
  const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');

  // The envelope the emergency route builds, with its own commandId shape.
  const envelope = {
    schemaVersion: 1,
    commandId: 'emergency-news-abcd1234',
    command: 'create_news',
    issuedAt: '2026-09-07T00:00:00Z',
    context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID },
    payload: { title: 'Closure notice', blocks: [{ type: 'paragraph', content: 'We are closed.' }] }
  };

  const parsed = CommandEnvelope.safeParse(envelope);
  assert.ok(parsed.success, `the emergency route builds an invalid envelope: ${JSON.stringify(parsed.error?.issues)}`);
  assert.equal(parsed.data.context.targetSite, SITE_ID);
});
