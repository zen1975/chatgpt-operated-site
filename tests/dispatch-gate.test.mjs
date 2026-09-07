import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadRuleVersion } from '../scripts/load-command-contracts.mjs';
import { canonicalCommandDigest as digestOf } from '../scripts/dispatch-command.mjs';
import {
  assertRemoteIdentity,
  validateCommand,
  preflightCommand,
  checkAssetIntakeReadiness,
  lookupCommand,
  bindPreflightReceipt,
  dispatchToWorker,
  runDispatch,
  DispatchError
} from '../scripts/dispatch-command.mjs';

const { RULE_VERSION } = await loadRuleVersion();
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;
const example = async (name) => JSON.parse(await readFile(path.join(repoRoot, 'examples/commands', name), 'utf8'));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const base = { endpoint: 'https://worker.example.com', controlSecret: 'control-secret', commandSecret: 'command-secret' };
const DISPATCH_PATH = '/api/internal/commands';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * A stand-in for the installation that models the parts of Worker behaviour
 * this gate depends on: a jobs table keyed by commandId, idempotency resolved
 * from it, and a mutation counter so a test can prove how many times state
 * actually changed.
 */
function installation({ readiness, preflight, jobs = new Map(), loseNextResponse = false, siteId = SITE_ID, attestIdentity = true } = {}) {
  const calls = [];
  let mutations = 0;
  let lose = loseNextResponse;

  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });

    const lookup = pathname.match(/^\/api\/control\/commands\/([^/]+)\/$/);
    if (lookup) {
      const commandId = decodeURIComponent(lookup[1]);
      const job = jobs.get(commandId);
      const attestation = attestIdentity ? { siteId } : {};
      return json(200, job
        ? { success: true, ...attestation, commandId, known: true, status: job.status, commandDigest: job.commandDigest ?? null, finishedAt: job.finishedAt, result: job.status === 'success' ? job.result : null }
        : { success: true, ...attestation, commandId, known: false, status: null });
    }

    if (pathname === '/api/control/readiness/asset-intake/') {
      if (!readiness) throw new Error('readiness was not expected for this command');
      return json(200, { success: true, readiness });
    }

    if (pathname === '/api/control/preflight/') {
      if (!preflight) throw new Error('preflight was not expected for this command');
      return preflight;
    }

    if (pathname === DISPATCH_PATH) {
      const command = JSON.parse(init.body);
      const existing = jobs.get(command.commandId);
      // Mirrors the Worker: idempotency is keyed by the complete command, so a
      // reused id with a different digest is refused rather than answered.
      if (existing?.status === 'success') {
        const submitted = await digestOf(command);
        if (!existing.commandDigest) return json(409, { success: false, error: { code: 'COMMAND_DIGEST_UNVERIFIABLE', message: 'stored job predates digests' } });
        if (existing.commandDigest !== submitted) return json(409, { success: false, error: { code: 'COMMAND_ID_REUSED', message: 'commandId already succeeded for a different command' } });
        return json(200, { success: true, commandId: command.commandId, idempotent: true, result: existing.result });
      }
      mutations += 1;
      const result = { id: `content_${mutations}`, version: 1 };
      jobs.set(command.commandId, { status: 'success', result, commandDigest: await digestOf(command), finishedAt: new Date().toISOString() });
      if (lose) {
        lose = false;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return json(200, { success: true, commandId: command.commandId, idempotent: false, result });
    }

    throw new Error(`unexpected request to ${pathname}`);
  };

  return {
    fetchImpl,
    calls,
    jobs,
    get mutations() { return mutations; },
    reachedDispatch: () => calls.some((call) => call.pathname === DISPATCH_PATH),
    dispatchBodies: () => calls.filter((call) => call.pathname === DISPATCH_PATH).map((call) => JSON.parse(call.body))
  };
}

const PREFLIGHT_OK = json(200, { success: true, siteId: SITE_ID, preflight: { commandDigest: DIGEST, contractVersion: 'v1', sideEffects: false, ok: true } });
const READY = { status: 'READY', code: 'ASSET_INTAKE_READY', provider: 'google_drive', checks: [] };

const imageCommand = async (overrides = {}) => {
  const command = await example('replace-content-image.json');
  command.payload.contentId = 'content_1';
  command.payload.reference.providerAssetId = 'drive-file-1';
  return { ...command, ...overrides };
};

/** Every rejected gate must leave the mutation endpoint untouched. */
async function assertBlocked(site, run, predicate) {
  await assert.rejects(run, predicate);
  assert.equal(site.reachedDispatch(), false, 'a rejected gate must not reach /api/internal/commands');
  assert.equal(site.mutations, 0, 'a rejected gate must not mutate');
}

// ---------------------------------------------------------------- gate 1 & 2

test('a shipped example passes the local gates', async () => {
  const { command } = await validateCommand(await example('create-news.json'));
  assert.equal(command.command, 'create_news');
});

test('a command that cannot be addressed is rejected before anything is sent', async () => {
  const site = installation();
  const command = await example('create-news.json');
  delete command.commandId;
  await assertBlocked(site, () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'schema' && e.code === 'COMMAND_ID_INVALID');
});

// An envelope that cannot be canonicalized cannot be digested, and without a
// digest it cannot be matched against a stored job -- so it is refused before
// the lookup rather than being admitted on its id alone.
test('an envelope invalid beyond its addressing fields is refused before lookup', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  const command = await example('create-news.json');
  command.schemaVersion = 99;
  await assertBlocked(site, async () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'schema' && e.code === 'COMMAND_NOT_CANONICALIZABLE');
});

test('the full envelope schema still rejects a malformed envelope', async () => {
  const command = await example('create-news.json');
  command.schemaVersion = 99;
  await assert.rejects(() => validateCommand(command), (e) => e.stage === 'schema' && e.code === 'ENVELOPE_INVALID');
});

test('an invalid payload is rejected before anything is sent', async () => {
  const site = installation();
  const command = await example('create-news.json');
  command.payload.title = '';
  await assertBlocked(site, () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.code === 'PAYLOAD_INVALID');
});

test('a stale rule version is rejected locally', async () => {
  const site = installation();
  const command = await example('create-news.json');
  command.context.ruleVersion = '0.0.1-old';
  await assertBlocked(site, () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'rule-version');
});

// -------------------------------------------------------- gate 3: target site

test('a command for another installation is refused', async () => {
  const site = installation();
  const command = await example('create-news.json');
  command.context.targetSite = 'some-other-customer-site';
  await assertBlocked(
    site,
    () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'target-site' && e.code === 'TARGET_SITE_MISMATCH'
  );
});

test('a command with no target site is refused rather than treated as a wildcard', async () => {
  const site = installation();
  const command = await example('create-news.json');
  delete command.context.targetSite;
  await assertBlocked(
    site,
    () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    // Required both by the authoritative envelope and by the minimal pre-lookup
    // validation, so an unaddressed command never reaches the installation.
    (e) => e.stage === 'target-site' && e.code === 'TARGET_SITE_REQUIRED'
  );
});

test('target site is checked before any network request', async () => {
  const site = installation();
  const command = await example('create-news.json');
  command.context.targetSite = 'elsewhere';
  await assert.rejects(() => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }));
  assert.deepEqual(site.calls, [], 'no request may leave the gate for a mismatched target site');
});

test('the shipped examples target this installation', async () => {
  for (const name of ['create-news.json', 'replace-content-image.json']) {
    assert.equal((await example(name)).context.targetSite, SITE_ID);
    assert.equal((await example(name)).context.ruleVersion, RULE_VERSION);
  }
});

// ------------------------------------------- gate 4: derived asset intake need

test('an image command with the flag removed is refused, not silently skipped', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  const command = await imageCommand();
  delete command.context.requiresAssetIntake;
  await assertBlocked(
    site,
    () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'asset-intake' && e.code === 'ASSET_INTAKE_FLAG_MISSING'
  );
});

test('an image command with the flag set false is refused', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  const command = await imageCommand();
  command.context.requiresAssetIntake = false;
  await assertBlocked(site, () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.code === 'ASSET_INTAKE_FLAG_MISSING');
});

test('a text command claiming to need intake is refused', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  const command = await example('create-news.json');
  command.context.requiresAssetIntake = true;
  await assertBlocked(site, () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.code === 'ASSET_INTAKE_FLAG_UNEXPECTED');
});

// A reference-bearing command may also name a canonical assetId, which is
// already inside the Asset Engine. It is still an image-bearing operation --
// the contract requires the flag -- but no provider has to be ready for it.
test('a replace_asset using a canonical assetId is image-bearing but needs no provider', async () => {
  const command = await example('replace-content-image.json');
  command.payload.contentId = 'content_1';
  delete command.payload.reference;
  command.payload.assetId = 'asset_existing';

  const outcome = await validateCommand(command);
  assert.equal(outcome.imageBearing, true, 'the contract still calls this image-bearing');
  assert.equal(outcome.intake, null, 'but no provider readiness is required');
});

test('provider readiness is derived from the payload, not from the flag', async () => {
  const { intake } = await validateCommand(await imageCommand());
  assert.deepEqual({ provider: intake.provider, via: intake.via }, { provider: 'google_drive', via: 'payload.reference.provider' });
});

// ------------------------------------------- gate 4: provider-aware readiness

test('readiness NOT_READY blocks despite HTTP 200', async () => {
  const site = installation({ readiness: { status: 'NOT_READY', code: 'DRIVE_INTAKE_FOLDER_NOT_FOUND', checks: [{ id: 'folder', status: 'FAIL', code: 'DRIVE_INTAKE_FOLDER_NOT_FOUND' }] }, preflight: PREFLIGHT_OK });
  await assertBlocked(
    site,
    async () => runDispatch({ command: await imageCommand(), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'readiness' && e.code === 'DRIVE_INTAKE_FOLDER_NOT_FOUND'
  );
});

// The readiness endpoint evaluates Google Drive credentials and the Drive
// intake folder specifically. Using its verdict for another provider would be
// asserting something the application never checked.
test('a generated-provider reference is not judged by Drive readiness', async () => {
  const site = installation({ readiness: READY, preflight: PREFLIGHT_OK });
  const command = await imageCommand();
  command.payload.reference.provider = 'generated';

  await assertBlocked(
    site,
    () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'readiness' && e.code === 'ASSET_INTAKE_READINESS_UNSUPPORTED'
  );
  assert.ok(!site.calls.some((call) => call.pathname.includes('readiness')), 'the Drive readiness endpoint must not be consulted for another provider');
});

test('an unsupported provider fails closed with an explicit error', async () => {
  const site = installation();
  await assert.rejects(
    () => checkAssetIntakeReadiness({ provider: 'wordpress', ...base, fetchImpl: site.fetchImpl }),
    (e) => e.code === 'ASSET_INTAKE_READINESS_UNSUPPORTED' && e.details.provider === 'wordpress'
  );
  assert.deepEqual(site.calls, []);
});

test('google_drive is checked against the Drive readiness endpoint', async () => {
  const site = installation({ readiness: READY });
  const outcome = await checkAssetIntakeReadiness({ provider: 'google_drive', ...base, fetchImpl: site.fetchImpl });
  assert.equal(outcome.readiness.status, 'READY');
  assert.deepEqual(site.calls.map((call) => call.pathname), ['/api/control/readiness/asset-intake/']);
});

// ---------------------------------------------------------- gate 5: preflight

test('preflight rejects a receipt that reports side effects', async () => {
  const site = installation({ preflight: json(200, { success: true, siteId: SITE_ID, preflight: { commandDigest: DIGEST, contractVersion: 'v1', sideEffects: true } }) });
  await assertBlocked(
    site,
    async () => runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.code === 'PREFLIGHT_NOT_SIDE_EFFECT_FREE'
  );
});

test('a version conflict from preflight stops the dispatch', async () => {
  const site = installation({ preflight: json(409, { success: false, error: { code: 'CONTENT_VERSION_CONFLICT', message: 'stale', details: { expectedVersion: 1, currentVersion: 4 } } }) });
  await assertBlocked(
    site,
    async () => runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'preflight' && e.code === 'CONTENT_VERSION_CONFLICT'
  );
});

test('the preflight receipt is bound into the dispatched envelope', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  await runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} });
  assert.deepEqual(site.dispatchBodies()[0].context.preflight, { commandDigest: DIGEST, contractVersion: 'v1' });
});

test('binding the receipt changes nothing else in the command', async () => {
  const command = await example('create-news.json');
  const bound = bindPreflightReceipt(command, { commandDigest: DIGEST, contractVersion: 'v1' });
  assert.deepEqual({ ...bound, context: { ...bound.context, preflight: undefined } }, { ...command, context: { ...command.context, preflight: undefined } });
});

// -------------------------------------------------- idempotent replay recovery

// The exact failure this must survive: the mutation committed, the response was
// lost, and the operator re-runs the same immutable command.
test('a lost dispatch response is recoverable and mutates only once', async () => {
  const site = installation({ preflight: PREFLIGHT_OK, loseNextResponse: true });
  const command = await example('create-news.json');

  await assert.rejects(() => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }));
  assert.equal(site.mutations, 1, 'the first dispatch must have mutated');
  const original = site.jobs.get(command.commandId).result;

  const replay = await runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  assert.equal(replay.replay, true);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.result.result, original, 'the original successful result must be recovered');
  assert.equal(site.mutations, 1, 'the retry must not mutate a second time');
});

test('same id and identical digest returns the original result', async () => {
  const command = await example('create-news.json');
  const site = installation({
    jobs: new Map([[command.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: await digestOf(command), finishedAt: '2026-09-07T00:00:00Z' }]])
  });
  const result = await runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  assert.equal(result.replay, true);
  assert.deepEqual(result.result.result, { id: 'content_1' });
  assert.equal(site.mutations, 0, 'a replay must not mutate');
});

// Reusing a successful id for different work must not be answered from the old
// result: that would silently skip the mutation just requested.
test('same id with a different command type is refused', async () => {
  const original = await example('create-news.json');
  const reused = await example('replace-content-image.json');
  reused.commandId = original.commandId;
  reused.payload.contentId = 'content_1';
  reused.payload.reference.providerAssetId = 'drive-file-1';

  const site = installation({
    readiness: READY,
    preflight: PREFLIGHT_OK,
    jobs: new Map([[original.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: await digestOf(original) }]])
  });

  await assertBlocked(site, async () => runDispatch({ command: reused, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'idempotency' && e.code === 'COMMAND_ID_REUSED');
});

test('same id and same type but a different payload is refused', async () => {
  const original = await example('create-news.json');
  const altered = await example('create-news.json');
  altered.payload.title = 'A different headline entirely';

  const site = installation({
    preflight: PREFLIGHT_OK,
    jobs: new Map([[original.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: await digestOf(original) }]])
  });

  await assertBlocked(site, async () => runDispatch({ command: altered, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.code === 'COMMAND_ID_REUSED');
});

test('same id with a different target site is refused before lookup', async () => {
  const original = await example('create-news.json');
  const altered = await example('create-news.json');
  altered.context.targetSite = 'another-installation';

  const site = installation({ jobs: new Map([[original.commandId, { status: 'success', result: {}, commandDigest: await digestOf(original) }]]) });
  await assertBlocked(site, async () => runDispatch({ command: altered, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'target-site');
});

// A command is immutable: it cannot be reissued under a newer rule version
// without becoming a different command. Recovering one must therefore not
// require it to satisfy today's admission rules.
test('a successful old-rule command replays after a rule-version change', async () => {
  const command = await example('create-news.json');
  command.context.ruleVersion = '0.0.9-previous';

  const site = installation({
    jobs: new Map([[command.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: await digestOf(command), finishedAt: '2026-09-06T00:00:00Z' }]])
  });
  const result = await runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  assert.equal(result.replay, true);
  assert.deepEqual(result.result.result, { id: 'content_1' });
  assert.equal(site.mutations, 0);
});

// ...but only because it already succeeded. There is no general stale-rule
// bypass: an unknown id under an old rule version is new work and is refused.
test('an unknown old-rule command is still refused', async () => {
  const command = await example('create-news.json');
  command.commandId = 'unknown-old-rule-command-001';
  command.context.ruleVersion = '0.0.9-previous';

  const site = installation({ preflight: PREFLIGHT_OK });
  await assertBlocked(site, async () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'rule-version' && e.code === 'RULE_VERSION_CONFLICT');
});

// A job written before digests were stored cannot be shown to describe this
// command, and "cannot tell" is not "matches".
test('a legacy job with no stored digest fails closed', async () => {
  const command = await example('create-news.json');
  const site = installation({
    preflight: PREFLIGHT_OK,
    jobs: new Map([[command.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: null }]])
  });

  await assertBlocked(site, async () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'idempotency' && e.code === 'COMMAND_DIGEST_UNVERIFIABLE');
});

test('a stale expectedVersion does not block a replay of a completed command', async () => {
  const command = await example('create-news.json');
  const site = installation({
    preflight: json(409, { success: false, error: { code: 'CONTENT_VERSION_CONFLICT', message: 'stale' } }),
    jobs: new Map([[command.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: await digestOf(command), finishedAt: '2026-09-07T00:00:00Z' }]])
  });
  const result = await runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  assert.equal(result.replay, true);
  assert.ok(!site.calls.some((call) => call.pathname === '/api/control/preflight/'), 'a completed command must not be re-preflighted');
  assert.equal(site.mutations, 0);
});

test('an unseen commandId still passes every gate: no general preflight bypass', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  await runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  assert.ok(site.calls.some((call) => call.pathname === '/api/control/preflight/'), 'a new command must be preflighted');
  assert.equal(site.mutations, 1);
});

test('a previously failed commandId is re-gated rather than replayed', async () => {
  const site = installation({
    preflight: PREFLIGHT_OK,
    jobs: new Map([['example-create-news-001', { status: 'failed', result: null, commandDigest: null }]])
  });
  const result = await runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  assert.equal(result.replay, false);
  assert.ok(site.calls.some((call) => call.pathname === '/api/control/preflight/'), 'a failed attempt must be re-preflighted');
});

test('an unreadable command lookup fails closed', async () => {
  await assert.rejects(
    () => lookupCommand({ commandId: 'whatever-id', ...base, fetchImpl: async () => json(500, { success: false, error: { code: 'CONTROL_READ_FAILED', message: 'db down' } }) }),
    (e) => e.stage === 'idempotency' && e.code === 'CONTROL_READ_FAILED'
  );
});

test('a replay the Worker does not answer idempotently is stopped', async () => {
  const command = await example('create-news.json');
  const digest = await digestOf(command);
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.startsWith('/api/control/commands/')) return json(200, { success: true, siteId: SITE_ID, known: true, status: 'success', commandDigest: digest, result: { id: 'content_1' } });
    if (pathname === DISPATCH_PATH) return json(200, { success: true, idempotent: false, result: { id: 'content_2' } });
    throw new Error(`unexpected ${pathname}`);
  };
  await assert.rejects(
    () => runDispatch({ command, ...base }, { fetchImpl, log: () => {} }),
    (e) => e.stage === 'idempotency' && e.code === 'REPLAY_NOT_IDEMPOTENT'
  );
});

// ------------------------------------------------------------ transport & config

test('a dry run passes every gate and dispatches nothing', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  const result = await runDispatch({ command: await example('create-news.json'), ...base, dryRun: true }, { fetchImpl: site.fetchImpl, log: () => {} });
  assert.equal(result.dispatched, false);
  assert.equal(site.reachedDispatch(), false);
  assert.equal(site.mutations, 0);
});

test('the dispatch request is signed over its exact body', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  await runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} });

  const call = site.calls.find((entry) => entry.pathname === DISPATCH_PATH);
  const timestamp = call.headers['x-command-timestamp'];
  assert.equal(call.headers['x-command-signature'], createHmac('sha256', base.commandSecret).update(`${timestamp}.${call.body}`).digest('hex'));
  assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 5 * 60 * 1000);
});

test('control requests are signed over timestamp, method and path', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  await runDispatch({ command: await example('create-news.json'), ...base, dryRun: true }, { fetchImpl: site.fetchImpl, log: () => {} });

  for (const call of site.calls) {
    const timestamp = call.headers['x-control-timestamp'];
    assert.equal(
      call.headers['x-control-signature'],
      createHmac('sha256', base.controlSecret).update(`${timestamp}.${call.method}.${call.pathname}`).digest('hex'),
      `${call.pathname} signature must cover timestamp, method and path`
    );
  }
});

test('a failed dispatch surfaces the Worker error code', async () => {
  await assert.rejects(
    async () => dispatchToWorker({ command: await example('create-news.json'), ...base, fetchImpl: async () => json(422, { success: false, error: { code: 'COMMAND_AUTHORIZATION_REQUIRED', message: 'scope missing' } }) }),
    (e) => e.stage === 'dispatch' && e.code === 'COMMAND_AUTHORIZATION_REQUIRED'
  );
});

test('missing configuration fails closed rather than dispatching unauthenticated', async () => {
  const previous = { ...process.env };
  delete process.env.SITE_COMMAND_ENDPOINT;
  delete process.env.CONTROL_READ_HMAC_SECRET;
  try {
    await assert.rejects(
      async () => runDispatch({ command: await example('create-news.json'), dryRun: true }, { fetchImpl: async () => { throw new Error('must not be reached'); }, log: () => {} }),
      (e) => e.stage === 'configuration' && e.code === 'MISSING_CONFIGURATION'
    );
  } finally {
    Object.assign(process.env, previous);
  }
});

// ----------------------------------------------------- command id contract

// The envelope and the lookup route share one CommandId schema. When the
// envelope was looser, an id it admitted could be unaddressable by the lookup
// the gate performs on every dispatch.
test('ids the lookup route cannot address are refused at gate 1', async () => {
  const rejected = {
    unicode: 'command-\u30b3\u30de\u30f3\u30c9-001',
    accented: 'commande-cr\u00e9\u00e9e-001',
    whitespace: 'example create news 001',
    slash: 'example/create-news/001',
    overlength: `x${'a'.repeat(200)}`,
    tooShort: 'short',
    percent: 'example%2Fnews-001'
  };

  for (const [label, commandId] of Object.entries(rejected)) {
    const site = installation();
    const command = { ...(await example('create-news.json')), commandId };
    await assertBlocked(
      site,
      async () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
      (e) => e.stage === 'schema' && e.code === 'COMMAND_ID_INVALID'
    );
    assert.deepEqual(site.calls, [], `${label}: a malformed commandId must be rejected before any request`);
  }
});

test('the id format is safe in a URL path segment', async () => {
  const command = await example('create-news.json');
  assert.equal(encodeURIComponent(command.commandId), command.commandId, 'a valid id must survive URL encoding unchanged');
});

// ------------------------------------------------------ target site contract

test('the envelope itself requires targetSite', async () => {
  const contracts = await (await import('../scripts/load-command-contracts.mjs')).loadCommandContracts();
  const command = await example('create-news.json');
  delete command.context.targetSite;
  assert.equal(contracts.CommandEnvelope.safeParse(command).success, false, 'targetSite must be mandatory in the authoritative schema, not only in the gate');

  const empty = await example('create-news.json');
  empty.context.targetSite = '';
  assert.equal(contracts.CommandEnvelope.safeParse(empty).success, false, 'an empty targetSite must not satisfy the schema');
});

test('the published envelope schema marks targetSite required', async () => {
  const published = JSON.parse(await readFile(path.join(repoRoot, 'schemas/command-envelope.schema.json'), 'utf8'));
  assert.ok(published.properties.context.required.includes('targetSite'));
  assert.equal(published.properties.commandId.pattern, '^[A-Za-z0-9._:-]+$');
  assert.equal(published.properties.commandId.maxLength, 200);
});

// ------------------------------------------------------------ command source

test('supplying both command sources is refused', async () => {
  const site = installation();
  await assertBlocked(
    site,
    async () => runDispatch({ commandFile: 'examples/commands/create-news.json', commandJson: JSON.stringify(await example('create-news.json')), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'command-source' && e.code === 'AMBIGUOUS_COMMAND'
  );
});

test('supplying neither command source is refused', async () => {
  const site = installation();
  await assertBlocked(
    site,
    async () => runDispatch({ ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'command-source' && e.code === 'NO_COMMAND'
  );
});

test('an inline command alone is accepted', async () => {
  const site = installation({ preflight: PREFLIGHT_OK });
  const result = await runDispatch({ commandJson: JSON.stringify(await example('create-news.json')), ...base, dryRun: true }, { fetchImpl: site.fetchImpl, log: () => {} });
  assert.equal(result.dispatched, false);
  assert.equal(result.command.command, 'create_news');
});

test('blank workflow inputs read as unsupplied, so both can be passed through', async () => {
  const { parseArgs } = await import('../scripts/dispatch-command.mjs');
  const inline = JSON.stringify({ ok: true });

  // How the workflow invokes it: both flags always present, one blank.
  assert.deepEqual(parseArgs(['--command-file', '', '--command', inline]), { dryRun: false, commandFile: undefined, commandJson: inline });
  assert.deepEqual(parseArgs(['--command-file', 'examples/commands/create-news.json', '--command', '']), { dryRun: false, commandFile: 'examples/commands/create-news.json', commandJson: undefined });

  // Both genuinely supplied, and neither supplied.
  assert.throws(() => parseArgs(['--command-file', 'examples/commands/create-news.json', '--command', inline]), (e) => e.code === 'AMBIGUOUS_COMMAND');
  assert.throws(() => parseArgs(['--command-file', '', '--command', '']), (e) => e.code === 'NO_COMMAND');
});

// --------------------------------------------------- remote site identity

// Authentication proves the caller holds the configured secret. It does not
// prove the configuration points at the right installation: an environment
// copied between customers authenticates perfectly against the wrong site.
test('local A + command A + remote A is allowed', async () => {
  const site = installation({ preflight: PREFLIGHT_OK, siteId: SITE_ID });
  const result = await runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} });
  assert.equal(result.dispatched, true);
  assert.equal(site.mutations, 1);
});

test('local A + command A + remote B is rejected with zero mutations', async () => {
  const site = installation({ preflight: PREFLIGHT_OK, siteId: 'a-different-customer-site' });
  await assertBlocked(
    site,
    async () => runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'remote-identity' && e.code === 'REMOTE_SITE_IDENTITY_MISMATCH'
  );
});

test('a remote that attests no identity is rejected', async () => {
  const site = installation({ preflight: PREFLIGHT_OK, attestIdentity: false });
  await assertBlocked(
    site,
    async () => runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'remote-identity' && e.code === 'REMOTE_SITE_IDENTITY_MISSING'
  );
});

// The check runs on the first authenticated response, so a replay cannot slip
// past it either.
test('a replay against the wrong remote is rejected before dispatch', async () => {
  const command = await example('create-news.json');
  const site = installation({
    siteId: 'a-different-customer-site',
    jobs: new Map([[command.commandId, { status: 'success', result: { id: 'content_1' }, commandDigest: await digestOf(command) }]])
  });
  await assertBlocked(site, async () => runDispatch({ command, ...base }, { fetchImpl: site.fetchImpl, log: () => {} }), (e) => e.stage === 'remote-identity');
});

test('the preflight response must attest the same identity', async () => {
  const site = installation({ preflight: json(200, { success: true, siteId: 'a-different-customer-site', preflight: { commandDigest: DIGEST, contractVersion: 'v1', sideEffects: false } }) });
  await assertBlocked(
    site,
    async () => runDispatch({ command: await example('create-news.json'), ...base }, { fetchImpl: site.fetchImpl, log: () => {} }),
    (e) => e.stage === 'remote-identity' && e.details?.source === 'preflight'
  );
});

test('the attested identity must match the command target, not only local config', () => {
  assert.throws(
    () => assertRemoteIdentity({ attested: 'site-a', targetSite: 'site-b', localSiteId: 'site-a', source: 'command lookup' }),
    (e) => e.code === 'REMOTE_SITE_IDENTITY_MISMATCH'
  );
  assert.doesNotThrow(() => assertRemoteIdentity({ attested: 'site-a', targetSite: 'site-a', localSiteId: 'site-a', source: 'command lookup' }));
});
