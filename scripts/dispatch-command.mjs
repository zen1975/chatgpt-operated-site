#!/usr/bin/env node
// The GitHub Actions dispatch gate.
//
// This is the "GitHub Actions validation / dispatch" stage of the documented
// control path:
//
//   ChatGPT -> immutable Command -> [ this gate ] -> Cloudflare Worker
//           -> D1 / R2 -> Astro render
//
// It is the only supported way an operator command reaches the Worker, and it
// runs four gates in a fixed order. Every one of them fails closed: nothing is
// dispatched unless all of them pass.
//
//   1. Schema        the envelope and payload validate against the current Zod
//                    contracts in src/server, locally, before anything is sent.
//   2. Rule version  context.ruleVersion equals the runtime rule version, so a
//                    command written against an older contract stops here
//                    rather than being rejected after dispatch.
//   3. Target site   context.targetSite equals this installation's canonical
//                    identity from config/site-profile.json. The Worker does not
//                    check this, and the endpoint comes from local
//                    configuration, so without this gate a command prepared for
//                    another customer could be applied to whichever site the
//                    workflow points at.
//   4. Readiness     for commands that actually carry an Asset Intake source,
//                    the authenticated readiness check for the provider that
//                    source names. AGENTS.md assigns this to the dispatch gate
//                    precisely because the ChatGPT client cannot perform an
//                    authenticated check itself.
//   5. Preflight     an authenticated, read-only, side-effect-free check of the
//                    current state (existence and expectedVersion). Its receipt
//                    -- commandDigest plus contractVersion -- is bound into the
//                    envelope, and the Worker re-derives the digest and refuses
//                    a command that changed after it was attested.
//
// Gates 3 and 4 are derived, not declared. targetSite is required rather than
// optional, and the Asset Intake requirement is read out of the validated
// payload; context.requiresAssetIntake is caller-supplied metadata that is
// cross-checked against the payload and rejected when the two disagree.
//
// One path skips the state gates: a commandId the installation has already
// recorded as successful. That is a completed mutation being re-answered after
// a lost response, not new work -- its expectedVersion is legitimately stale.
// A commandId the installation has never seen is never treated this way.
//
// Secrets are used to compute signatures and are never printed. The command
// document is echoed as the operation record; it must never carry credentials.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { repoRoot } from './repo-root.mjs';
import { loadCommandContracts, loadRuleVersion, loadServerModule } from './load-command-contracts.mjs';

const loadDigest = () => loadServerModule('src/server/control-plane/digest.ts');

/**
 * The minimum that must hold before the installation can be asked whether this
 * command already ran: an addressable commandId and the right installation.
 *
 * Deliberately not the full schema. A command whose dispatch response was lost
 * is immutable -- it cannot be reissued under a newer rule version without
 * becoming a different command -- so validating it against the *current*
 * admission rules before discovering it already succeeded would strand it
 * exactly as the stale expectedVersion did. Admission rules judge new work.
 */
export async function validateForLookup(command) {
  const contracts = await loadCommandContracts();

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new DispatchError('schema', 'COMMAND_NOT_AN_OBJECT', 'The command must be a JSON object.');
  }

  const commandId = contracts.CommandId.safeParse(command.commandId);
  if (!commandId.success) {
    throw new DispatchError('schema', 'COMMAND_ID_INVALID', 'commandId is missing or not a valid identifier, so this command cannot be addressed.', commandId.error.issues);
  }

  const siteId = await installationSiteId();
  const targetSite = command?.context?.targetSite;
  if (!targetSite) {
    throw new DispatchError('target-site', 'TARGET_SITE_REQUIRED', `The command does not name a target site. This installation is "${siteId}"; set context.targetSite to it.`);
  }
  if (targetSite !== siteId) {
    throw new DispatchError('target-site', 'TARGET_SITE_MISMATCH', `The command targets "${targetSite}" but this installation is "${siteId}". Refusing to mutate a site the command was not written for.`, { targetSite, installation: siteId });
  }

  return { commandId: commandId.data, siteId };
}

/** The canonical digest, from the same implementation the Worker uses. */
export async function canonicalCommandDigest(command) {
  const { commandDigest } = await loadDigest();
  try {
    return await commandDigest(command);
  } catch (error) {
    throw new DispatchError('schema', 'COMMAND_NOT_CANONICALIZABLE', `The command cannot be canonicalized, so it cannot be matched against a stored job: ${error.message}`);
  }
}

/** The canonical identity of this installation. */
async function installationSiteId() {
  const profile = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8'));
  const id = profile?.site?.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new DispatchError('target-site', 'SITE_IDENTITY_MISSING', 'config/site-profile.json does not define site.id, so the gate cannot prove which installation it is dispatching to.');
  }
  return id;
}

/**
 * Whether an operation is image-bearing, and which assets it carries.
 *
 * Both come from `src/server/command-assets.ts` -- the same module the Worker
 * uses -- rather than being re-derived here. The gate previously grew its own
 * partial answer twice: first a list of command names, then a page-only
 * extension, and each time a payload shape that can carry an asset was missed.
 * A gate-local rule is a second definition of where assets live, and it drifts.
 */
const loadCommandAssets = () => loadServerModule('src/server/command-assets.ts');

export async function isImageBearingOperation(command, validatedPayload) {
  const { isImageBearingOperation: decide } = await loadCommandAssets();
  return decide(command, validatedPayload);
}

export async function extractCommandAssetReferences(command, validatedPayload) {
  const { extractCommandAssetReferences: extract } = await loadCommandAssets();
  return extract(command, validatedPayload);
}

/**
 * Whether this particular command brings an asset in through a provider, and
 * from which provider.
 *
 * The narrower question. Only a provider reference needs intake -- a canonical
 * assetId already exists inside the Asset Engine, so running a readiness check
 * for it would gate the command on infrastructure it does not use.
 */
function providerIntake(command, payload) {
  if (command === 'import_wordpress_asset') {
    return { provider: 'wordpress', via: 'command' };
  }
  if (REFERENCE_BEARING_COMMANDS.has(command) && payload?.reference) {
    return { provider: payload.reference.provider ?? null, via: 'payload.reference.provider' };
  }
  return null;
}

/**
 * Commands whose payload may carry a provider reference.
 *
 * The attach commands are deliberately absent: their schemas require a
 * canonical assetId and reject a reference, so listing them here would advertise
 * an intake path that fails at gate 1.
 */
const REFERENCE_BEARING_COMMANDS = new Set([
  'replace_asset',
  'replace_product_asset',
  'replace_page_section_asset'
]);

/**
 * Providers with a canonical readiness mechanism in this application.
 *
 * Only Google Drive has one: /api/control/readiness/asset-intake/ evaluates
 * Drive credentials and the Drive intake folder specifically. Treating that
 * verdict as evidence for any other provider would be inventing a check the
 * application does not implement, so every other provider fails closed here
 * rather than being waved through or judged by the wrong signal.
 */
const READINESS_MECHANISMS = {
  google_drive: { pathname: '/api/control/readiness/asset-intake/', description: 'Google Drive Asset Intake readiness' }
};

class DispatchError extends Error {
  constructor(stage, code, message, details) {
    super(message);
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

const hmacHex = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new DispatchError('configuration', 'MISSING_CONFIGURATION', `${name} is not set. The dispatch gate fails closed rather than dispatching unauthenticated.`);
  return value;
}

export function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    // An empty value means "this input was left blank", so the workflow can
    // hand over both inputs verbatim and let the ambiguity check above run.
    else if (arg === '--command-file') options.commandFile = (argv[++index] || '').trim() || undefined;
    else if (arg === '--command') options.commandJson = (argv[++index] || '').trim() || undefined;
    else throw new DispatchError('configuration', 'UNKNOWN_ARGUMENT', `Unknown argument: ${arg}`);
  }
  assertSingleSource(options);
  return options;
}

const run = promisify(execFile);

/**
 * Exactly one command source. The caller passes both through independently --
 * the workflow hands over its two inputs verbatim -- so this check actually
 * sees an ambiguous pair instead of one being silently preferred and the other
 * discarded, which would dispatch an operation the operator did not intend.
 */
export function assertSingleSource({ commandFile, commandJson }) {
  if (commandFile && commandJson) {
    throw new DispatchError('command-source', 'AMBIGUOUS_COMMAND', 'Both a command and a command_file were supplied. Provide exactly one: refusing to guess which operation was intended.');
  }
  if (!commandFile && !commandJson) {
    throw new DispatchError('command-source', 'NO_COMMAND', 'Provide exactly one of --command-file <path> or --command <json>.');
  }
}

/**
 * Resolve --command-file to a committed blob, and return that blob's bytes.
 *
 * The working tree is never read. "Tracked" is not the same as "unmodified":
 * `git ls-files --error-unmatch` only asks whether a path is in the index, so a
 * committed command file edited locally would still have been dispatched --
 * and, since the gate echoes the command as the operation record, printed.
 * Reading `HEAD:<path>` instead means the bytes dispatched are exactly the
 * bytes the repository carries.
 *
 * It also removes a whole class of path attack: a blob inside the HEAD tree
 * cannot be an absolute path, a traversal, or a symlink target outside the
 * repository, because it is not a filesystem lookup at all. The string checks
 * remain so those inputs are refused with a precise reason.
 *
 * Arguments are passed as an argv array with `--` before the path, never
 * through a shell.
 */
export async function resolveCommandFile(commandFile, { cwd = repoRoot, gitImpl = run } = {}) {
  if (path.isAbsolute(commandFile)) {
    throw new DispatchError('command-source', 'COMMAND_FILE_ABSOLUTE', 'command_file must be a repository-relative path, not an absolute path.');
  }
  const segments = commandFile.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new DispatchError('command-source', 'COMMAND_FILE_TRAVERSAL', 'command_file must not traverse out of the repository with "..".');
  }

  const relative = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!relative) {
    throw new DispatchError('command-source', 'COMMAND_FILE_NOT_A_FILE', 'command_file must name a file.');
  }

  let entry;
  try {
    const { stdout } = await gitImpl('git', ['ls-tree', '-z', 'HEAD', '--', relative], { cwd });
    entry = stdout.split('\0').filter(Boolean)[0];
  } catch (error) {
    throw new DispatchError(
      'command-source',
      'COMMAND_FILE_NOT_TRACKED',
      `command_file could not be read from the committed tree: ${relative}. A dispatched command must be a committed file, and this check cannot be skipped when git is unavailable.`
    );
  }

  if (!entry) {
    throw new DispatchError('command-source', 'COMMAND_FILE_NOT_TRACKED', `command_file is not a committed file in this repository: ${relative}.`);
  }

  // "<mode> <type> <sha>\t<path>"
  const match = entry.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64})\t/);
  if (!match) {
    throw new DispatchError('command-source', 'COMMAND_FILE_NOT_TRACKED', `Could not interpret the committed tree entry for ${relative}.`);
  }
  const [, mode, type, sha] = match;

  if (type === 'tree' || mode === '040000') {
    throw new DispatchError('command-source', 'COMMAND_FILE_NOT_A_FILE', 'command_file must be a regular file, not a directory.');
  }
  if (mode === '120000') {
    throw new DispatchError('command-source', 'COMMAND_FILE_SYMLINK', 'command_file is a symlink in the committed tree. Refusing to follow it: name the file itself.');
  }
  if (mode === '160000') {
    throw new DispatchError('command-source', 'COMMAND_FILE_NOT_A_FILE', 'command_file points at a submodule.');
  }
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
    throw new DispatchError('command-source', 'COMMAND_FILE_NOT_A_FILE', `command_file is not a regular committed blob (mode ${mode}, type ${type}).`);
  }

  let contents;
  try {
    const { stdout } = await gitImpl('git', ['cat-file', 'blob', sha], { cwd, maxBuffer: 8 * 1024 * 1024 });
    contents = stdout;
  } catch (error) {
    throw new DispatchError('command-source', 'COMMAND_FILE_UNREADABLE', `The committed blob for ${relative} could not be read.`);
  }

  return { relativePath: relative, blobSha: sha, contents };
}

async function readCommand(options) {
  assertSingleSource(options);
  // The committed bytes, never the working tree.
  const raw = options.commandFile ? (await resolveCommandFile(options.commandFile)).contents : options.commandJson;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new DispatchError('schema', 'COMMAND_NOT_JSON', `The command is not valid JSON: ${error.message}`);
  }
}

/** Gate 1 and 2. Purely local: no network, no credentials. */
export async function validateCommand(command) {
  const contracts = await loadCommandContracts();
  const { RULE_VERSION } = await loadRuleVersion();

  const envelope = contracts.CommandEnvelope.safeParse(command);
  if (!envelope.success) {
    throw new DispatchError('schema', 'ENVELOPE_INVALID', 'The command envelope does not match the current schema.', envelope.error.issues);
  }

  const schema = contracts.COMMAND_PAYLOAD_SCHEMAS[envelope.data.command];
  if (!schema) {
    throw new DispatchError('schema', 'COMMAND_UNKNOWN', `No payload contract is registered for ${envelope.data.command}.`);
  }

  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new DispatchError('schema', 'PAYLOAD_INVALID', `The payload does not match the schema for ${envelope.data.command}.`, payload.error.issues);
  }

  if (envelope.data.context.ruleVersion !== RULE_VERSION) {
    throw new DispatchError(
      'rule-version',
      'RULE_VERSION_CONFLICT',
      `The command was written against rule version ${envelope.data.context.ruleVersion}; this installation runs ${RULE_VERSION}. Refresh the contract and reissue the command.`
    );
  }

  // The Worker does not check targetSite, and the endpoint comes from this
  // repository's own configuration -- so a command prepared for another
  // installation, run from the wrong repository, would otherwise be applied to
  // whichever site this workflow happens to point at. Required, not optional:
  // an absent targetSite is an unaddressed command, not a wildcard.
  const siteId = await installationSiteId();
  const targetSite = envelope.data.context.targetSite;
  if (!targetSite) {
    throw new DispatchError('target-site', 'TARGET_SITE_REQUIRED', `The command does not name a target site. This installation is "${siteId}"; set context.targetSite to it.`);
  }
  if (targetSite !== siteId) {
    throw new DispatchError('target-site', 'TARGET_SITE_MISMATCH', `The command targets "${targetSite}" but this installation is "${siteId}". Refusing to mutate a site the command was not written for.`, { targetSite, installation: siteId });
  }

  // Two separate questions, deliberately not collapsed into one boolean.
  //
  //   1. Is this an image-bearing command? The contract requires the flag on
  //      those, including when the asset is named by canonical id.
  //   2. Does a provider have to be ready? Only when the asset actually arrives
  //      through one.
  const imageBearing = await isImageBearingOperation(envelope.data.command, payload.data);
  const intake = providerIntake(envelope.data.command, payload.data);
  const flagged = envelope.data.context.requiresAssetIntake === true;

  if (imageBearing && !flagged) {
    throw new DispatchError('asset-intake', 'ASSET_INTAKE_FLAG_MISSING', `${envelope.data.command} is an image-bearing operation, so context.requiresAssetIntake must be true.`, { command: envelope.data.command });
  }
  if (!imageBearing && flagged) {
    throw new DispatchError('asset-intake', 'ASSET_INTAKE_FLAG_UNEXPECTED', `context.requiresAssetIntake is true but ${envelope.data.command} is not an image-bearing operation.`);
  }

  return { command: envelope.data, payload: payload.data, ruleVersion: RULE_VERSION, siteId, imageBearing, intake };
}

function signedControlRequest(endpoint, pathname, method, secret) {
  const timestamp = new Date().toISOString();
  return {
    url: `${endpoint}${pathname}`,
    init: {
      method,
      headers: {
        'x-control-timestamp': timestamp,
        'x-control-signature': hmacHex(secret, `${timestamp}.${method}.${pathname}`),
        'content-type': 'application/json'
      }
    }
  };
}

/** Gate 4. Only for image-bearing commands. */
export async function checkAssetIntakeReadiness({ provider, endpoint, controlSecret, commandDigest, fetchImpl = fetch }) {
  const mechanism = READINESS_MECHANISMS[provider];
  if (!mechanism) {
    throw new DispatchError(
      'readiness',
      'ASSET_INTAKE_READINESS_UNSUPPORTED',
      `This application has no canonical readiness check for the "${provider}" Asset Intake provider, so the gate cannot prove it is usable. ` +
        `Refusing to dispatch rather than substituting another provider's verdict. Supported: ${Object.keys(READINESS_MECHANISMS).join(', ')}.`,
      { provider, supported: Object.keys(READINESS_MECHANISMS) }
    );
  }
  // The digest travels with the request so the installation can bind its
  // receipt to this exact command rather than issuing a standing one.
  const pathname = commandDigest ? `${mechanism.pathname}?commandDigest=${encodeURIComponent(commandDigest)}` : mechanism.pathname;
  const { url, init } = signedControlRequest(endpoint, mechanism.pathname, 'GET', controlSecret);
  init.__signedPath = mechanism.pathname;
  const response = await fetchImpl(`${endpoint}${pathname}`, init);
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.success) {
    throw new DispatchError('readiness', body?.error?.code || 'READINESS_UNAVAILABLE', body?.error?.message || `Asset Intake readiness could not be evaluated (HTTP ${response.status}).`);
  }
  // A 200 means the evaluation ran, not that the provider is usable. The
  // verdict is readiness.status, and anything but READY stops the dispatch.
  if (body.readiness?.status !== 'READY') {
    throw new DispatchError('readiness', body.readiness?.code || 'ASSET_INTAKE_NOT_READY', 'Asset Intake is not ready, so an image-bearing command cannot be dispatched.', {
      status: body.readiness?.status,
      failedChecks: (body.readiness?.checks || []).filter((check) => check.status === 'FAIL').map((check) => ({ id: check.id, code: check.code }))
    });
  }
  if (commandDigest && !body.receipt) {
    throw new DispatchError('readiness', 'READINESS_RECEIPT_NOT_ISSUED', 'The installation reported READY but issued no readiness receipt, so provider intake cannot be authorised.');
  }
  return { readiness: body.readiness, receipt: body.receipt };
}

/** Gate 3. Read-only; the Worker reports sideEffects:false. */
export async function preflightCommand({ command, endpoint, controlSecret, fetchImpl = fetch, ...options }) {
  const pathname = '/api/control/preflight/';
  const { url, init } = signedControlRequest(endpoint, pathname, 'POST', controlSecret);
  const response = await fetchImpl(url, { ...init, body: JSON.stringify(command) });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.success) {
    throw new DispatchError('preflight', body?.error?.code || 'PREFLIGHT_FAILED', body?.error?.message || `Preflight failed (HTTP ${response.status}).`, body?.error?.details);
  }
  if (options?.expectSiteIdentity) {
    assertRemoteIdentity({ attested: body.siteId, ...options.expectSiteIdentity, source: 'preflight' });
  }
  const receipt = body.preflight;
  if (!receipt?.commandDigest || !receipt?.contractVersion) {
    throw new DispatchError('preflight', 'PREFLIGHT_RECEIPT_INVALID', 'Preflight did not return a usable receipt.');
  }
  if (receipt.sideEffects !== false) {
    throw new DispatchError('preflight', 'PREFLIGHT_NOT_SIDE_EFFECT_FREE', 'Preflight reported side effects; refusing to continue.');
  }
  return receipt;
}

/**
 * Bind the receipt to the command. commandDigest is computed over the envelope
 * with context.preflight removed, so attaching the receipt cannot change the
 * digest it attests.
 */
export function bindPreflightReceipt(command, receipt) {
  return {
    ...command,
    context: {
      ...command.context,
      preflight: { commandDigest: receipt.commandDigest, contractVersion: receipt.contractVersion }
    }
  };
}

/**
 * Has this exact commandId already been executed?
 *
 * This is what makes a lost dispatch response recoverable without opening a
 * hole: the replay path is entered only for a commandId the installation has
 * already recorded as successful. A commandId the installation has never seen
 * is new work and goes through every gate, so this is not a general preflight
 * bypass.
 */
export async function lookupCommand({ commandId, endpoint, controlSecret, fetchImpl = fetch }) {
  const pathname = `/api/control/commands/${encodeURIComponent(commandId)}/`;
  const { url, init } = signedControlRequest(endpoint, pathname, 'GET', controlSecret);
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.success) {
    // Fail closed. Not knowing whether the command already ran is not the same
    // as knowing it did not.
    throw new DispatchError('idempotency', body?.error?.code || 'COMMAND_LOOKUP_FAILED', body?.error?.message || `Could not determine whether ${commandId} has already been executed (HTTP ${response.status}).`);
  }
  return body;
}

/**
 * Confirm the endpoint actually is the installation this command is for.
 *
 * Authentication proves the caller holds the configured secret; it does not
 * prove the configuration points at the right site. An environment copied
 * between installations -- endpoint and secrets belonging to site B while the
 * repository and the command name site A -- authenticates perfectly and would
 * otherwise mutate the wrong customer. The remote attests its own identity and
 * it must agree with *both* the command's target and this repository's
 * configuration.
 */
export function assertRemoteIdentity({ attested, targetSite, localSiteId, source }) {
  if (!attested) {
    throw new DispatchError(
      'remote-identity',
      'REMOTE_SITE_IDENTITY_MISSING',
      `The ${source} response did not attest a site identity, so the endpoint cannot be confirmed to be "${localSiteId}". Refusing to dispatch.`
    );
  }
  if (attested !== localSiteId || attested !== targetSite) {
    throw new DispatchError(
      'remote-identity',
      'REMOTE_SITE_IDENTITY_MISMATCH',
      `The endpoint identifies itself as "${attested}", but this repository is configured for "${localSiteId}" and the command targets "${targetSite}". The endpoint or its secrets belong to a different installation. Refusing to dispatch.`,
      { attested, localSiteId, targetSite, source }
    );
  }
}

export async function dispatchToWorker({ command, endpoint, commandSecret, fetchImpl = fetch }) {
  const body = JSON.stringify(command);
  const timestamp = new Date().toISOString();
  const response = await fetchImpl(`${endpoint}/api/internal/commands`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-command-timestamp': timestamp,
      'x-command-signature': hmacHex(commandSecret, `${timestamp}.${body}`)
    },
    body
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    throw new DispatchError('dispatch', result?.error?.code || 'DISPATCH_FAILED', result?.error?.message || `Dispatch failed (HTTP ${response.status}).`, result?.error?.details);
  }
  return result;
}

export async function runDispatch(options, io = {}) {
  const log = io.log || console.log;
  const fetchImpl = io.fetchImpl || fetch;
  const command = options.command ?? (await readCommand(options));

  // Step 1: only what is needed to address this command safely. Nothing is
  // echoed yet -- the operation record is written from a validated value.
  const { commandId, siteId } = await validateForLookup(command);
  const digest = await canonicalCommandDigest(command);

  const endpoint = (options.endpoint ?? requireEnv('SITE_COMMAND_ENDPOINT')).replace(/\/+$/, '');
  const controlSecret = options.controlSecret ?? requireEnv('CONTROL_READ_HMAC_SECRET');

  // Step 2: is this a completed command being re-answered, or new work?
  const prior = await lookupCommand({ commandId, endpoint, controlSecret, fetchImpl });

  // ...and is this endpoint even the installation the command is for? Checked
  // on the first authenticated response, so nothing -- replay included --
  // reaches /api/internal/commands against the wrong site.
  assertRemoteIdentity({ attested: prior.siteId, targetSite: command.context.targetSite, localSiteId: siteId, source: 'command lookup' });

  if (prior.known && prior.status === 'success') {
    // Idempotency is bound to the complete immutable command. An id that
    // succeeded for a *different* command is reuse, not a replay: answering it
    // from the stored result would silently skip the mutation just requested.
    if (!prior.commandDigest) {
      throw new DispatchError('idempotency', 'COMMAND_DIGEST_UNVERIFIABLE', `${commandId} already succeeded, but the stored job predates command digests, so it cannot be confirmed to be this command. Issue a new commandId.`);
    }
    if (prior.commandDigest !== digest) {
      throw new DispatchError('idempotency', 'COMMAND_ID_REUSED', `${commandId} already succeeded for a different command. A commandId identifies one immutable command and cannot be reused; issue a new commandId.`, { storedDigest: prior.commandDigest, submittedDigest: digest });
    }

    log(`command      ${command.command}`);
    log(`commandId    ${commandId}`);
    log(`\nreplay       already succeeded at ${prior.finishedAt ?? 'an earlier run'}; digest matches.`);
    log('             Re-sending so the Worker returns the recorded result. No new mutation.');

    if (options.dryRun) {
      log('\ndry run: nothing was dispatched. The recorded result is shown above.');
      return { dispatched: false, replay: true, commandId, digest, priorResult: prior.result };
    }

    const commandSecret = options.commandSecret ?? requireEnv('COMMAND_HMAC_SECRET');
    const result = await dispatchToWorker({ command, endpoint, commandSecret, fetchImpl });
    if (!result.idempotent) {
      throw new DispatchError('idempotency', 'REPLAY_NOT_IDEMPOTENT', `${commandId} was recorded as successful, but the Worker did not answer the replay idempotently. Stopping rather than risking a second mutation.`);
    }
    log('\nrecovered    original result returned; mutation ran once.');
    return { dispatched: true, replay: true, idempotent: true, commandId, digest, result, priorResult: prior.result };
  }

  if (prior.known && prior.status !== 'success') {
    log(`             a previous attempt for this commandId ended "${prior.status}"; running the full gates.`);
  }

  // Step 3: new work. Everything an incoming command must satisfy today.
  const { command: validated, intake, imageBearing } = await validateCommand(command);

  log('--- validated command ---');
  log(JSON.stringify(validated, null, 2));
  log('-------------------------');
  log(`command      ${validated.command}`);
  log(`commandId    ${validated.commandId}`);
  log('gate 1/5     schema         OK');
  log('gate 2/5     rule version   OK');
  log(`gate 3/5     target site    OK (${siteId})`);

  // Readiness runs only when an asset actually arrives through a provider. A
  // command naming a canonical assetId is still image-bearing, but it needs no
  // provider, so gating it on one would block it on unrelated infrastructure.
  let readinessReceipt;
  if (intake) {
    const outcome = await checkAssetIntakeReadiness({ provider: intake.provider, endpoint, controlSecret, commandDigest: digest, fetchImpl });
    readinessReceipt = outcome.receipt;
    log(`gate 4/6     asset intake   READY (${intake.provider}), receipt issued`);
  } else {
    log(`gate 4/6     asset intake   no provider intake for this command${imageBearing ? ' (canonical asset)' : ''}`);
  }

  const receipt = await preflightCommand({
    command: validated,
    endpoint,
    controlSecret,
    fetchImpl,
    expectSiteIdentity: { targetSite: validated.context.targetSite, localSiteId: siteId }
  });
  log(`gate 5/5     preflight      OK (${receipt.commandDigest})`);

  // Both attestations ride in context and are excluded from the digest they
  // bind to, so attaching them cannot change which command they attest.
  const bound = bindPreflightReceipt(readinessReceipt ? { ...validated, context: { ...validated.context, readinessReceipt } } : validated, receipt);

  if (options.dryRun) {
    log('\ndry run: all gates passed; nothing was dispatched.');
    return { dispatched: false, replay: false, command: bound, digest, receipt };
  }

  const commandSecret = options.commandSecret ?? requireEnv('COMMAND_HMAC_SECRET');
  const result = await dispatchToWorker({ command: bound, endpoint, commandSecret, fetchImpl });
  log(`\ndispatched   ${result.idempotent ? 'already applied (idempotent replay)' : 'applied'}`);
  return { dispatched: true, replay: false, command: bound, digest, receipt, result };
}

export { DispatchError, hmacHex, timingSafeEqual };

if (import.meta.filename === process.argv[1]) {
  try {
    await runDispatch(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof DispatchError) {
      console.error(`\nBLOCKED at the ${error.stage} gate: ${error.code}`);
      console.error(error.message);
      if (error.details) console.error(JSON.stringify(error.details, null, 2));
      console.error('\nNothing was dispatched. Do not bypass this gate with a direct database or source edit.');
      process.exit(1);
    }
    throw error;
  }
}
