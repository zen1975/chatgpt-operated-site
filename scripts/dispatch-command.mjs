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
//   3. Preflight     an authenticated, read-only, side-effect-free check of the
//                    current state (existence and expectedVersion). Its receipt
//                    -- commandDigest plus contractVersion -- is bound into the
//                    envelope, and the Worker re-derives the digest and refuses
//                    a command that changed after it was attested.
//   4. Readiness     for image-bearing commands, the authenticated Asset Intake
//                    readiness check. AGENTS.md assigns this to the dispatch
//                    gate precisely because the ChatGPT client cannot perform an
//                    authenticated check itself.
//
// Secrets are used to compute signatures and are never printed. The command
// document is echoed as the operation record; it must never carry credentials.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';
import { loadCommandContracts, loadRuleVersion } from './load-command-contracts.mjs';

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

  return { command: envelope.data, ruleVersion: RULE_VERSION };
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
export async function checkAssetIntakeReadiness({ endpoint, controlSecret, fetchImpl = fetch }) {
  const pathname = '/api/control/readiness/asset-intake/';
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

  const { command: validated } = await validateCommand(command);
  log('gate 1/4     schema        OK');
  log('gate 2/4     rule version  OK');

  const endpoint = (options.endpoint ?? requireEnv('SITE_COMMAND_ENDPOINT')).replace(/\/+$/, '');
  const controlSecret = options.controlSecret ?? requireEnv('CONTROL_READ_HMAC_SECRET');

  if (validated.context.requiresAssetIntake) {
    const readiness = await checkAssetIntakeReadiness({ endpoint, controlSecret, fetchImpl });
    log(`gate 4/4     asset intake  READY (${readiness.provider ?? 'provider'})`);
  } else {
    log('gate 4/4     asset intake  not required by this command');
  }

  const receipt = await preflightCommand({ command: validated, endpoint, controlSecret, fetchImpl });
  log(`gate 3/4     preflight     OK (${receipt.commandDigest})`);

  const bound = bindPreflightReceipt(validated, receipt);

  if (options.dryRun) {
    log('\ndry run: all gates passed; nothing was dispatched.');
    return { dispatched: false, command: bound, receipt };
  }

  const commandSecret = options.commandSecret ?? requireEnv('COMMAND_HMAC_SECRET');
  const result = await dispatchToWorker({ command: bound, endpoint, commandSecret, fetchImpl });
  log(`\ndispatched   ${result.idempotent ? 'already applied (idempotent replay)' : 'applied'}`);
  return { dispatched: true, command: bound, receipt, result };
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
