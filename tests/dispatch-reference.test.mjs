import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import {
  DispatchError,
  normalizeCommandPath,
  providerReference,
  readCommittedCommand,
  runDispatch,
  validateCommand
} from '../scripts/dispatch-command.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

const profile = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8'));
const base = JSON.parse(await readFile(path.join(repoRoot, 'examples/commands/create-news.json'), 'utf8'));
const image = JSON.parse(await readFile(path.join(repoRoot, 'examples/commands/replace-content-image.json'), 'utf8'));
const receipt = { commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'test-contract' };

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function transport({ ready = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (new URL(url).pathname === profile.operations.assetIntake.readinessPath) {
      return response({ success: true, readiness: { status: ready ? 'READY' : 'NOT_READY', code: ready ? 'ASSET_INTAKE_READY' : 'ASSET_INTAKE_NOT_READY' } });
    }
    if (new URL(url).pathname === '/api/control/preflight/') return response({ success: true, preflight: receipt });
    if (new URL(url).pathname === '/api/internal/commands/') return response({ success: true, result: { applied: true } });
    return response({ success: false, error: { code: 'UNEXPECTED_PATH' } }, 404);
  };
  return { calls, fetchImpl };
}

const options = (stub, dryRun = false) => ({
  endpoint: 'https://site.example.test',
  controlSecret: 'control-test-secret',
  commandSecret: 'command-test-secret',
  dryRun,
  fetchImpl: stub.fetchImpl,
  profile
});

test('the shipped create-news command validates against the real contracts', async () => {
  const result = await validateCommand(base, profile);
  assert.equal(result.command.command, 'create_news');
});

test('invalid payload, stale rules, and the wrong site fail before network access', async () => {
  const cases = [
    { ...base, payload: {} },
    { ...base, context: { ...base.context, ruleVersion: 'stale' } },
    { ...base, context: { ruleVersion: base.context.ruleVersion } },
    { ...base, context: { ...base.context, targetSite: 'other-site' } }
  ];
  for (const command of cases) {
    const stub = transport();
    await assert.rejects(runDispatch(command, options(stub)), DispatchError);
    assert.equal(stub.calls.length, 0);
  }
});

test('provider references use readiness, preflight, then mutation', async () => {
  const stub = transport();
  const command = structuredClone(image);
  command.payload.contentId = 'content-example';
  command.payload.reference.providerAssetId = 'drive-file-example';
  await runDispatch(command, options(stub));
  assert.deepEqual(stub.calls.map((call) => call.url.pathname), [
    profile.operations.assetIntake.readinessPath,
    '/api/control/preflight/',
    '/api/internal/commands/'
  ]);
});

test('canonical asset IDs skip provider readiness', async () => {
  const stub = transport();
  const command = structuredClone(image);
  command.payload = { ...command.payload, contentId: 'content-example', assetId: 'asset-example' };
  delete command.payload.reference;
  await runDispatch(command, options(stub));
  assert.deepEqual(stub.calls.map((call) => call.url.pathname), ['/api/control/preflight/', '/api/internal/commands/']);
});

test('an unconfigured provider and a NOT_READY verdict fail before preflight', async () => {
  const wrongProvider = structuredClone(image);
  wrongProvider.payload.contentId = 'content-example';
  wrongProvider.payload.reference = { ...wrongProvider.payload.reference, provider: 'generated' };
  const first = transport();
  await assert.rejects(runDispatch(wrongProvider, options(first)), { code: 'ASSET_INTAKE_PROVIDER_NOT_CONFIGURED' });
  assert.equal(first.calls.length, 0);

  const notReady = structuredClone(image);
  notReady.payload.contentId = 'content-example';
  notReady.payload.reference.providerAssetId = 'drive-file-example';
  const second = transport({ ready: false });
  await assert.rejects(runDispatch(notReady, options(second)), { code: 'ASSET_INTAKE_NOT_READY' });
  assert.equal(second.calls.length, 1);
});

test('dry-run binds preflight but never reaches the mutation endpoint', async () => {
  const stub = transport();
  const result = await runDispatch(base, options(stub, true));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.command.context.preflight, receipt);
  assert.deepEqual(stub.calls.map((call) => call.url.pathname), ['/api/control/preflight/']);
});

test('dispatch binds the receipt and signs the exact body', async () => {
  const stub = transport();
  await runDispatch(base, options(stub));
  const call = stub.calls.at(-1);
  const timestamp = call.init.headers['x-command-timestamp'];
  const expected = createHmac('sha256', 'command-test-secret').update(`${timestamp}.${call.init.body}`).digest('hex');
  assert.equal(call.init.headers['x-command-signature'], expected);
  assert.deepEqual(JSON.parse(call.init.body).context.preflight, receipt);
});

test('provider detection is limited to schemas that own provider references', () => {
  assert.equal(providerReference('replace_asset', { reference: { provider: 'google_drive' } }).provider, 'google_drive');
  assert.equal(providerReference('create_news', { reference: { provider: 'google_drive' } }), null);
});

test('committed command reader uses the HEAD blob and rejects non-blob entries', async () => {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (args[0] === 'ls-tree') return `100644 blob ${'b'.repeat(40)}\texamples/commands/create-news.json\0`;
    return JSON.stringify(base);
  };
  assert.deepEqual(await readCommittedCommand('examples/commands/create-news.json', git), base);
  assert.equal(calls[1][0], 'cat-file');

  const symlink = async () => `120000 blob ${'c'.repeat(40)}\texamples/commands/create-news.json\0`;
  await assert.rejects(readCommittedCommand('examples/commands/create-news.json', symlink), { code: 'COMMAND_FILE_NOT_COMMITTED' });
});

test('command paths reject absolute paths and traversal', () => {
  assert.throws(() => normalizeCommandPath('/tmp/command.json'), { code: 'COMMAND_PATH_INVALID' });
  assert.throws(() => normalizeCommandPath('../command.json'), { code: 'COMMAND_PATH_INVALID' });
});

test('executeCommand enforces the site boundary independently of Actions', async () => {
  const { executeCommand } = await loadServerModule('src/server/commands.ts');
  const command = { ...base, context: { ...base.context, targetSite: 'other-site' } };
  await assert.rejects(
    executeCommand(command, { trustedAuthorization: { actor: 'test', scopes: ['content:write'] } }),
    { code: 'COMMAND_TARGET_SITE_MISMATCH' }
  );
});

test('the emergency ingress uses the same canonical site identity', async () => {
  const source = await readFile(path.join(repoRoot, 'src/pages/api/emergency/news.ts'), 'utf8');
  assert.match(source, /targetSite:\s*SITE_ID/);
  assert.doesNotMatch(source, /targetSite:\s*['\"]emergency-sheet['\"]/);
});

/**
 * astro.config.mjs sets trailingSlash: 'always', so an unslashed API path is
 * answered with a 308. The HMAC signature covers the path and is computed
 * before that redirect, so an unslashed request is verified against a path it
 * did not sign and fails with CONTROL_READ_AUTH_INVALID. Every signed request
 * must therefore be built on the slashed path.
 */
test('every signed request path carries a trailing slash', async () => {
  const stub = transport();
  const command = structuredClone(image);
  command.payload.contentId = 'content-example';
  command.payload.reference.providerAssetId = 'drive-file-example';
  await runDispatch(command, options(stub));
  assert.ok(stub.calls.length > 0);
  for (const call of stub.calls) {
    assert.ok(call.url.pathname.endsWith('/'), `signed path must end with '/': ${call.url.pathname}`);
  }
});
