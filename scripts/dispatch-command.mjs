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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';
import { loadCommandContracts, loadRuleVersion } from './load-command-contracts.mjs';

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
 * Which commands carry an Asset Intake source, and where that source names its
 * provider. Derived from the payload -- never from context.requiresAssetIntake,
 * which is optional caller-supplied metadata.
 */
function assetIntakeRequirement(command, payload) {
  if (command === 'create_asset') {
    return { required: true, provider: payload?.descriptor?.sourceProvider ?? null, via: 'payload.descriptor.sourceProvider' };
  }
  if (command === 'import_wordpress_asset') {
    return { required: true, provider: 'wordpress', via: 'command' };
  }
  // Reference-bearing commands take *either* a canonical assetId already inside
  // the Asset Engine, which needs no intake, or a provider reference, which
  // does. Only the second form requires readiness.
  if (REFERENCE_BEARING_COMMANDS.has(command) && payload?.reference) {
    return { required: true, provider: payload.reference.provider ?? null, via: 'payload.reference.provider' };
  }
  return { required: false, provider: null, via: null };
}

const REFERENCE_BEARING_COMMANDS = new Set([
  'replace_asset',
  'attach_product_asset',
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

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--command-file') options.commandFile = argv[++index];
    else if (arg === '--command') options.commandJson = argv[++index];
    else throw new DispatchError('configuration', 'UNKNOWN_ARGUMENT', `Unknown argument: ${arg}`);
  }
  if (!options.commandFile && !options.commandJson) {
    throw new DispatchError('configuration', 'NO_COMMAND', 'Provide --command-file <path> or --command <json>.');
  }
  if (options.commandFile && options.commandJson) {
    throw new DispatchError('configuration', 'AMBIGUOUS_COMMAND', 'Provide exactly one of --command-file or --command.');
  }
  return options;
}

async function readCommand(options) {
  const raw = options.commandFile
    ? await readFile(path.resolve(repoRoot, options.commandFile), 'utf8')
    : options.commandJson;
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

  // Derived from the payload, then cross-checked against the caller's flag.
  const intake = assetIntakeRequirement(envelope.data.command, payload.data);
  const flagged = envelope.data.context.requiresAssetIntake === true;
  if (intake.required && !flagged) {
    throw new DispatchError('asset-intake', 'ASSET_INTAKE_FLAG_MISSING', `${envelope.data.command} carries an Asset Intake source (${intake.via}) but context.requiresAssetIntake is not true. The command contradicts itself.`, intake);
  }
  if (!intake.required && flagged) {
    throw new DispatchError('asset-intake', 'ASSET_INTAKE_FLAG_UNEXPECTED', `context.requiresAssetIntake is true but ${envelope.data.command} carries no Asset Intake source. The command contradicts itself.`);
  }

  return { command: envelope.data, payload: payload.data, ruleVersion: RULE_VERSION, siteId, intake };
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
export async function checkAssetIntakeReadiness({ provider, endpoint, controlSecret, fetchImpl = fetch }) {
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
  const pathname = mechanism.pathname;
  const { url, init } = signedControlRequest(endpoint, pathname, 'GET', controlSecret);
  const response = await fetchImpl(url, init);
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
  return body.readiness;
}

/** Gate 3. Read-only; the Worker reports sideEffects:false. */
export async function preflightCommand({ command, endpoint, controlSecret, fetchImpl = fetch }) {
  const pathname = '/api/control/preflight/';
  const { url, init } = signedControlRequest(endpoint, pathname, 'POST', controlSecret);
  const response = await fetchImpl(url, { ...init, body: JSON.stringify(command) });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.success) {
    throw new DispatchError('preflight', body?.error?.code || 'PREFLIGHT_FAILED', body?.error?.message || `Preflight failed (HTTP ${response.status}).`, body?.error?.details);
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

  log(`command      ${command.command ?? '(unknown)'}`);
  log(`commandId    ${command.commandId ?? '(unknown)'}`);

  const { command: validated, siteId, intake } = await validateCommand(command);
  log('gate 1/5     schema         OK');
  log('gate 2/5     rule version   OK');
  log(`gate 3/5     target site    OK (${siteId})`);

  const endpoint = (options.endpoint ?? requireEnv('SITE_COMMAND_ENDPOINT')).replace(/\/+$/, '');
  const controlSecret = options.controlSecret ?? requireEnv('CONTROL_READ_HMAC_SECRET');

  // Before any state gate: a command that already succeeded is a completed
  // mutation being re-answered, not new work. Its expectedVersion is
  // legitimately stale now, so running preflight against it would report a
  // conflict and strand a dispatch whose response was merely lost.
  const prior = await lookupCommand({ commandId: validated.commandId, endpoint, controlSecret, fetchImpl });

  if (prior.known && prior.status === 'success') {
    log(`\nreplay       ${validated.commandId} already succeeded at ${prior.finishedAt ?? 'an earlier run'}.`);
    log('             Re-sending so the Worker returns the recorded result. No new mutation.');

    if (options.dryRun) {
      log('\ndry run: nothing was dispatched. The recorded result is shown above.');
      return { dispatched: false, replay: true, command: validated, priorResult: prior.result };
    }

    const commandSecret = options.commandSecret ?? requireEnv('COMMAND_HMAC_SECRET');
    // The Worker resolves idempotency by commandId before any contract gate, so
    // this returns the original result rather than mutating a second time.
    const result = await dispatchToWorker({ command: validated, endpoint, commandSecret, fetchImpl });
    if (!result.idempotent) {
      throw new DispatchError('idempotency', 'REPLAY_NOT_IDEMPOTENT', `${validated.commandId} was recorded as successful, but the Worker did not answer the replay idempotently. Stopping rather than risking a second mutation.`);
    }
    log('\nrecovered    original result returned; mutation ran once.');
    return { dispatched: true, replay: true, idempotent: true, command: validated, result, priorResult: prior.result };
  }

  if (prior.known && prior.status !== 'success') {
    log(`             previous attempt for this commandId ended "${prior.status}"; re-running the gates.`);
  }

  if (intake.required) {
    const readiness = await checkAssetIntakeReadiness({ provider: intake.provider, endpoint, controlSecret, fetchImpl });
    log(`gate 4/5     asset intake   READY (${intake.provider})`);
    void readiness;
  } else {
    log('gate 4/5     asset intake   not required by this command');
  }

  const receipt = await preflightCommand({ command: validated, endpoint, controlSecret, fetchImpl });
  log(`gate 5/5     preflight      OK (${receipt.commandDigest})`);

  const bound = bindPreflightReceipt(validated, receipt);

  if (options.dryRun) {
    log('\ndry run: all gates passed; nothing was dispatched.');
    return { dispatched: false, replay: false, command: bound, receipt };
  }

  const commandSecret = options.commandSecret ?? requireEnv('COMMAND_HMAC_SECRET');
  const result = await dispatchToWorker({ command: bound, endpoint, commandSecret, fetchImpl });
  log(`\ndispatched   ${result.idempotent ? 'already applied (idempotent replay)' : 'applied'}`);
  return { dispatched: true, replay: false, command: bound, receipt, result };
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
