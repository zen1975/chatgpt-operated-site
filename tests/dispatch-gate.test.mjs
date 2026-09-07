import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadRuleVersion } from '../scripts/load-command-contracts.mjs';
import {
  validateCommand,
  preflightCommand,
  checkAssetIntakeReadiness,
  bindPreflightReceipt,
  dispatchToWorker,
  runDispatch,
  DispatchError
} from '../scripts/dispatch-command.mjs';

const { RULE_VERSION } = await loadRuleVersion();
const example = async (name) => JSON.parse(await readFile(path.join(repoRoot, 'examples/commands', name), 'utf8'));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

/** Records every request so a test can assert what did and did not go out. */
function transport(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const pathname = new URL(url).pathname;
    const handler = handlers[pathname];
    if (!handler) throw new Error(`unexpected request to ${pathname}`);
    return typeof handler === 'function' ? handler(init) : handler;
  };
  return { calls, fetchImpl };
}

const PREFLIGHT_OK = ok({ success: true, contractVersion: 'v1', preflight: { commandDigest: DIGEST, contractVersion: 'v1', sideEffects: false, ok: true } });
const READINESS_OK = ok({ success: true, readiness: { status: 'READY', code: 'ASSET_INTAKE_READY', provider: 'google_drive', checks: [], sideEffects: false } });
const DISPATCH_OK = ok({ success: true, commandId: 'x', result: {} });

const base = { endpoint: 'https://worker.example.com', controlSecret: 'control-secret', commandSecret: 'command-secret' };

test('a shipped example passes the local gates', async () => {
  const { command } = await validateCommand(await example('create-news.json'));
  assert.equal(command.command, 'create_news');
});

test('an invalid envelope is rejected before anything is sent', async () => {
  const command = await example('create-news.json');
  delete command.commandId;
  await assert.rejects(() => validateCommand(command), (error) => error instanceof DispatchError && error.stage === 'schema' && error.code === 'ENVELOPE_INVALID');
});

test('an invalid payload is rejected before anything is sent', async () => {
  const command = await example('create-news.json');
  command.payload.title = '';
  await assert.rejects(() => validateCommand(command), (error) => error instanceof DispatchError && error.code === 'PAYLOAD_INVALID');
});

// The gate catches this locally so the operator gets a clear instruction
// instead of a RULE_VERSION_CONFLICT after the command has been dispatched.
test('a stale rule version is rejected locally', async () => {
  const command = await example('create-news.json');
  command.context.ruleVersion = '0.0.1-old';
  await assert.rejects(() => validateCommand(command), (error) => error.stage === 'rule-version' && error.code === 'RULE_VERSION_CONFLICT');
});

test('the example rule version matches this installation', async () => {
  assert.equal((await example('create-news.json')).context.ruleVersion, RULE_VERSION);
});

test('preflight rejects a receipt that reports side effects', async () => {
  const { fetchImpl } = transport({
    '/api/control/preflight/': ok({ success: true, preflight: { commandDigest: DIGEST, contractVersion: 'v1', sideEffects: true } })
  });
  await assert.rejects(
    async () => preflightCommand({ command: await example('create-news.json'), ...base, fetchImpl }),
    (error) => error.code === 'PREFLIGHT_NOT_SIDE_EFFECT_FREE'
  );
});

test('a version conflict from preflight stops the dispatch', async () => {
  const { fetchImpl, calls } = transport({
    '/api/control/preflight/': fail(409, { success: false, error: { code: 'CONTENT_VERSION_CONFLICT', message: 'stale', details: { expectedVersion: 1, currentVersion: 4 } } })
  });
  await assert.rejects(
    async () => preflightCommand({ command: await example('create-news.json'), ...base, fetchImpl }),
    (error) => error.stage === 'preflight' && error.code === 'CONTENT_VERSION_CONFLICT'
  );
  assert.equal(calls.filter((call) => call.url.includes('/api/internal/commands')).length, 0);
});

// The readiness endpoint answers 200 even when the provider is unusable, so
// reading the HTTP status instead of the verdict would dispatch into a broken
// Asset Intake.
test('readiness NOT_READY blocks despite HTTP 200', async () => {
  const { fetchImpl } = transport({
    '/api/control/readiness/asset-intake/': ok({
      success: true,
      readiness: { status: 'NOT_READY', code: 'DRIVE_INTAKE_FOLDER_NOT_FOUND', provider: 'google_drive', checks: [{ id: 'folder', status: 'FAIL', code: 'DRIVE_INTAKE_FOLDER_NOT_FOUND' }] }
    })
  });
  await assert.rejects(
    async () => checkAssetIntakeReadiness({ ...base, fetchImpl }),
    (error) => error.stage === 'readiness' && error.code === 'DRIVE_INTAKE_FOLDER_NOT_FOUND'
  );
});

test('an image-bearing command is not dispatched when Asset Intake is not ready', async () => {
  const { fetchImpl, calls } = transport({
    '/api/control/readiness/asset-intake/': ok({ success: true, readiness: { status: 'NOT_READY', code: 'ASSET_INTAKE_NOT_CONFIGURED', checks: [] } }),
    '/api/control/preflight/': PREFLIGHT_OK,
    '/api/internal/commands': DISPATCH_OK
  });
  const command = await example('replace-content-image.json');
  command.payload.contentId = 'content_1';
  command.payload.reference.providerAssetId = 'drive-file-1';

  await assert.rejects(() => runDispatch({ command, ...base, dryRun: false }, { fetchImpl, log: () => {} }), (error) => error.stage === 'readiness');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/api/control/readiness/asset-intake/']);
});

test('readiness is skipped for a command that needs no asset intake', async () => {
  const { fetchImpl, calls } = transport({ '/api/control/preflight/': PREFLIGHT_OK, '/api/internal/commands': DISPATCH_OK });
  await runDispatch({ command: await example('create-news.json'), ...base, dryRun: false }, { fetchImpl, log: () => {} });
  assert.ok(!calls.some((call) => call.url.includes('readiness')));
});

test('the preflight receipt is bound into the dispatched envelope', async () => {
  const { fetchImpl, calls } = transport({ '/api/control/preflight/': PREFLIGHT_OK, '/api/internal/commands': DISPATCH_OK });
  await runDispatch({ command: await example('create-news.json'), ...base, dryRun: false }, { fetchImpl, log: () => {} });

  const dispatched = JSON.parse(calls.find((call) => call.url.includes('/api/internal/commands')).body);
  assert.deepEqual(dispatched.context.preflight, { commandDigest: DIGEST, contractVersion: 'v1' });
});

// commandDigest is computed over the envelope with context.preflight removed,
// so binding the receipt must not disturb the command it attests.
test('binding the receipt changes nothing else in the command', async () => {
  const command = await example('create-news.json');
  const bound = bindPreflightReceipt(command, { commandDigest: DIGEST, contractVersion: 'v1' });
  assert.deepEqual({ ...bound, context: { ...bound.context, preflight: undefined } }, { ...command, context: { ...command.context, preflight: undefined } });
});

test('a dry run passes every gate and dispatches nothing', async () => {
  const { fetchImpl, calls } = transport({ '/api/control/preflight/': PREFLIGHT_OK });
  const result = await runDispatch({ command: await example('create-news.json'), ...base, dryRun: true }, { fetchImpl, log: () => {} });
  assert.equal(result.dispatched, false);
  assert.ok(!calls.some((call) => call.url.includes('/api/internal/commands')));
});

test('the dispatch request is signed over its exact body', async () => {
  const { fetchImpl, calls } = transport({ '/api/control/preflight/': PREFLIGHT_OK, '/api/internal/commands': DISPATCH_OK });
  await runDispatch({ command: await example('create-news.json'), ...base, dryRun: false }, { fetchImpl, log: () => {} });

  const call = calls.find((entry) => entry.url.includes('/api/internal/commands'));
  const timestamp = call.headers['x-command-timestamp'];
  const { createHmac } = await import('node:crypto');
  assert.equal(call.headers['x-command-signature'], createHmac('sha256', base.commandSecret).update(`${timestamp}.${call.body}`).digest('hex'));
  assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 5 * 60 * 1000, 'timestamp must be inside the Worker signature window');
});

test('control requests are signed over timestamp, method and path', async () => {
  const { fetchImpl, calls } = transport({ '/api/control/preflight/': PREFLIGHT_OK });
  await runDispatch({ command: await example('create-news.json'), ...base, dryRun: true }, { fetchImpl, log: () => {} });

  const call = calls[0];
  const { createHmac } = await import('node:crypto');
  const timestamp = call.headers['x-control-timestamp'];
  assert.equal(call.headers['x-control-signature'], createHmac('sha256', base.controlSecret).update(`${timestamp}.POST./api/control/preflight/`).digest('hex'));
});

test('a failed dispatch surfaces the Worker error code', async () => {
  const { fetchImpl } = transport({
    '/api/internal/commands': fail(422, { success: false, error: { code: 'COMMAND_AUTHORIZATION_REQUIRED', message: 'scope missing' } })
  });
  await assert.rejects(
    async () => dispatchToWorker({ command: await example('create-news.json'), ...base, fetchImpl }),
    (error) => error.stage === 'dispatch' && error.code === 'COMMAND_AUTHORIZATION_REQUIRED'
  );
});

test('missing configuration fails closed rather than dispatching unauthenticated', async () => {
  const previous = { ...process.env };
  delete process.env.SITE_COMMAND_ENDPOINT;
  delete process.env.CONTROL_READ_HMAC_SECRET;
  try {
    await assert.rejects(
      async () => runDispatch({ command: await example('create-news.json'), dryRun: true }, { fetchImpl: async () => { throw new Error('must not be reached'); }, log: () => {} }),
      (error) => error.stage === 'configuration' && error.code === 'MISSING_CONFIGURATION'
    );
  } finally {
    Object.assign(process.env, previous);
  }
});
