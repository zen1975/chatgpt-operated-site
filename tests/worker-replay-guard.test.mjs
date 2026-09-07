import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

// The dispatch gate must not be the sole protection: a command reaching the
// Worker by any other route is subject to the same rule. This is the Worker's
// own guard, tested directly.
const { evaluateReplay } = await loadServerModule('src/server/control-plane/replay.ts');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const success = (digest, result = { id: 'content_1' }) => ({ status: 'success', result_json: JSON.stringify(result), command_digest: digest });

test('no prior job is not a replay', () => {
  assert.deepEqual(evaluateReplay('cmd-00000001', DIGEST_A, null), { replay: false });
});

test('a non-successful prior job is not a replay', () => {
  assert.deepEqual(evaluateReplay('cmd-00000001', DIGEST_A, { status: 'failed', result_json: null, command_digest: DIGEST_A }), { replay: false });
});

test('a matching digest replays the stored result', () => {
  const outcome = evaluateReplay('cmd-00000001', DIGEST_A, success(DIGEST_A));
  assert.equal(outcome.replay, true);
  assert.deepEqual(outcome.result, { id: 'content_1' });
});

test('a different digest under the same id fails closed', () => {
  assert.throws(
    () => evaluateReplay('cmd-00000001', DIGEST_B, success(DIGEST_A)),
    (error) => error.code === 'COMMAND_ID_REUSED' && error.type === 'CONFLICT'
  );
});

test('a legacy job with no stored digest fails closed', () => {
  assert.throws(
    () => evaluateReplay('cmd-00000001', DIGEST_A, success(null)),
    (error) => error.code === 'COMMAND_DIGEST_UNVERIFIABLE'
  );
});

test('a null stored result still replays as null rather than throwing', () => {
  const outcome = evaluateReplay('cmd-00000001', DIGEST_A, { status: 'success', result_json: null, command_digest: DIGEST_A });
  assert.deepEqual(outcome, { replay: true, result: null });
});

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
