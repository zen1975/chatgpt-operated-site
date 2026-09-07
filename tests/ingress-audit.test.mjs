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
  'src/pages/api/control/readiness/asset-intake.ts': { executes: false, constructs: false, secret: 'CONTROL_READ_HMAC_SECRET' },
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
    // Constructs, executes, validates, resolves, or issues attestation for a
    // command. The readiness route qualifies: it signs evidence bound to a
    // specific command digest.
    if (/executeCommand\(|preflightCommand\(|CommandEnvelope|restToCanonicalCommand\(|CommandId|issueReadinessReceipt\(/.test(source)) commandCapable.push(route);
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

// ------------------------------------------ image contract at every ingress

// The Worker enforces the image-operation contract, so an authenticated ingress
// that does not pass through the dispatch gate inherits it rather than being a
// way around it.
test('no ingress can bypass the image-operation contract', async () => {
  const worker = await read('src/server/commands.ts');

  for (const [route, expected] of Object.entries(INGRESSES)) {
    if (!expected.executes) continue;
    const source = await read(route);
    // Every executing ingress goes through executeCommand, which is where the
    // contract lives. None may pre-approve intake on the caller's behalf.
    assert.match(source, /executeCommand\(/, `${route} must dispatch through executeCommand`);
    assert.ok(!/requiresAssetIntake\s*:\s*true/.test(source), `${route} must not assert intake on the caller's behalf`);
    assert.ok(!/readinessReceipt/.test(source), `${route} must not mint or inject readiness evidence`);
  }

  assert.match(worker, /ASSET_INTAKE_FLAG_MISSING/, 'the Worker enforces the flag contract');
  assert.match(worker, /verifyReadinessReceipt\(/, 'and requires readiness evidence for provider intake');
});

test('an ingress cannot name an actor it is not', async () => {
  const v1 = await read('src/pages/api/v1/commands.ts');
  const internal = await read('src/pages/api/internal/commands.ts');

  // Each route pins its own actor; the actor is not taken from the request.
  assert.match(v1, /trustedCommandRuntime\('authenticated-command-client'\)/, '/api/v1/commands must identify as itself');
  assert.match(internal, /trustedCommandRuntime\('github-actions'\)/, '/api/internal/commands identifies as the dispatch gate');
  assert.ok(!/trustedCommandRuntime\([^)]*(body|request|headers|input|payload)/.test(v1), 'the v1 actor must not come from the request');
  assert.ok(!/'github-actions'/.test(v1), '/api/v1/commands must not be able to claim the dispatch gate\'s actor');
});

test('the readiness receipt signature is compared in constant time', async () => {
  const source = await read('src/server/control-plane/readiness-receipt.ts');

  assert.match(source, /function safeEqual\(/, 'receipt verification must use a constant-time comparison');
  assert.match(source, /if \(!safeEqual\(receipt\.signature, expected\)\)/, 'and must actually use it');
  assert.ok(
    !/signature\s*!==\s*expected|expected\s*!==\s*receipt\.signature|signature\s*===\s*expected/.test(source),
    'a signature must never be compared with === or !==: the timing leak is what lets one be recovered byte by byte'
  );
});

test('the readiness receipt secret is separate from the command secret', async () => {
  const receipt = await read('src/server/control-plane/readiness-receipt.ts');
  assert.match(receipt, /READINESS_RECEIPT_HMAC_SECRET/, 'receipts use their own secret');
  assert.ok(!/COMMAND_HMAC_SECRET/.test(receipt), 'holding the command secret must not be enough to mint readiness evidence');

  // ...and the command ingress does not hold the receipt secret.
  for (const route of ['src/pages/api/v1/commands.ts', 'src/pages/api/internal/commands.ts']) {
    const source = await read(route);
    assert.ok(!/READINESS_RECEIPT_HMAC_SECRET/.test(source), `${route} must not hold the receipt secret`);
  }
});

test('the receipt is issued only from a verified readiness result', async () => {
  const endpoint = await read('src/pages/api/control/readiness/asset-intake.ts');

  assert.match(endpoint, /const readiness = await assetIntakeReadiness\(/, 'readiness is evaluated by the shared implementation');
  assert.match(endpoint, /readiness\.status === 'READY'/, 'and a receipt follows only from that result');
  assert.ok(!/body\.ready|input\.ready|searchParams\.get\('ready'\)/.test(endpoint), 'a caller-supplied verdict must never be signed');

  const receipt = await read('src/server/control-plane/readiness-receipt.ts');
  assert.match(receipt, /input\.readiness !== 'READY'/, 'the issuer refuses to sign a non-ready verdict');
});
