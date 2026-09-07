import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;

// The dispatch gate must not be the sole protection: a command reaching the
// Worker by any other route is subject to the same rules. The claim state
// machine itself is covered in command-claim.test.mjs against a real jobs
// table; this file covers the two invariants that must hold across the gate
// and the Worker together.
// The gate and the Worker must agree on what "the same command" means, or a
// command the gate treats as a replay could be treated as reuse by the Worker.
test('the gate and the Worker compute the same digest', async () => {
  const { commandDigest } = await loadServerModule('src/server/control-plane/digest.ts');
  const { canonicalCommandDigest } = await import('../scripts/dispatch-command.mjs');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { repoRoot } = await import('../scripts/repo-root.mjs');

  const command = JSON.parse(await readFile(path.join(repoRoot, 'examples/commands/create-news.json'), 'utf8'));
  assert.equal(await canonicalCommandDigest(command), await commandDigest(command));
});

// The preflight receipt is binding metadata about the command, not part of it,
// so attaching one must not change which stored job the command matches.
test('the preflight receipt is excluded from the digest on both sides', async () => {
  const { canonicalCommandDigest } = await import('../scripts/dispatch-command.mjs');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { repoRoot } = await import('../scripts/repo-root.mjs');

  const command = JSON.parse(await readFile(path.join(repoRoot, 'examples/commands/create-news.json'), 'utf8'));
  const bound = { ...command, context: { ...command.context, preflight: { commandDigest: DIGEST_A, contractVersion: 'v1' } } };
  assert.equal(await canonicalCommandDigest(bound), await canonicalCommandDigest(command));
});

// ------------------------------------------------- worker-side site identity

// The GitHub gate is not the boundary. A command reaching the Worker by any
// other route must still be refused if it names another installation.
const identity = await loadServerModule('src/server/site-identity.ts');

test('the Worker knows its own canonical identity', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { repoRoot } = await import('../scripts/repo-root.mjs');
  const profile = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8'));

  // One definition, shared with the repository configuration the gate reads.
  assert.equal(identity.SITE_ID, profile.site.id);
});

test('a command addressed to this installation is accepted', () => {
  assert.doesNotThrow(() => identity.assertCommandTargetsThisSite(identity.SITE_ID));
});

test('the Worker refuses a command addressed to another installation', () => {
  assert.throws(
    () => identity.assertCommandTargetsThisSite('a-different-customer-site'),
    (error) => error instanceof identity.SiteIdentityMismatch
  );
});

test('the Worker refuses a command with no target site', () => {
  assert.throws(() => identity.assertCommandTargetsThisSite(undefined), (error) => error instanceof identity.SiteIdentityMismatch);
  assert.throws(() => identity.assertCommandTargetsThisSite(''), (error) => error instanceof identity.SiteIdentityMismatch);
});

// The identity check runs before idempotency resolution, so a command that
// already succeeded elsewhere cannot be replayed into the wrong installation.
test('the site-identity check precedes idempotency in executeCommand', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { repoRoot } = await import('../scripts/repo-root.mjs');
  const source = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');

  const body = source.slice(source.indexOf('export async function executeCommand'));
  const identityAt = body.indexOf('assertCommandTargetsThisSite');
  const claimAt = body.indexOf('claimCommand(');
  const digestAt = body.indexOf('await commandDigest(cmd)');

  assert.ok(identityAt !== -1 && claimAt !== -1 && digestAt !== -1);
  assert.ok(identityAt < digestAt, 'the identity check must precede digest computation');
  assert.ok(identityAt < claimAt, 'the identity check must precede idempotency resolution, so a replay cannot bypass it');
});
