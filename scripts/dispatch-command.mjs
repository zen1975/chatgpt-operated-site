import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadCommandContracts, loadRuleVersion, repoRoot } from './load-command-contracts.mjs';

const execFileAsync = promisify(execFile);
const PROVIDER_REFERENCE_COMMANDS = new Set([
  'replace_asset',
  'replace_product_asset',
  'replace_page_section_asset'
]);

export class DispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseArgs(argv) {
  let commandFile = '';
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--command-file') commandFile = argv[++index] || '';
    else if (argv[index] === '--dry-run') dryRun = true;
    else throw new DispatchError('ARGUMENT_INVALID', `Unknown argument: ${argv[index]}`);
  }
  if (!commandFile) throw new DispatchError('COMMAND_FILE_REQUIRED', '--command-file is required.');
  return { commandFile, dryRun };
}

export function normalizeCommandPath(value) {
  if (path.isAbsolute(value)) throw new DispatchError('COMMAND_PATH_INVALID', 'Command path must be repository-relative.');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.split('/').includes('..') || !normalized.endsWith('.json')) {
    throw new DispatchError('COMMAND_PATH_INVALID', 'Command path must be a repository-relative JSON file without traversal.');
  }
  return normalized;
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout;
}

export async function readCommittedCommand(value, git = gitOutput) {
  const commandPath = normalizeCommandPath(value);
  let listing;
  try {
    listing = await git(['ls-tree', '-z', '--full-tree', 'HEAD', '--', commandPath]);
  } catch (error) {
    throw new DispatchError('GIT_COMMAND_READ_FAILED', error instanceof Error ? error.message : String(error));
  }
  const record = listing.replace(/\0+$/, '');
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
  if (!match || match[3] !== commandPath) {
    throw new DispatchError('COMMAND_FILE_NOT_COMMITTED', 'Command file must be a regular committed blob at HEAD.');
  }
  const raw = await git(['cat-file', 'blob', match[2]]);
  try { return JSON.parse(raw); }
  catch { throw new DispatchError('COMMAND_JSON_INVALID', 'Command file is not valid JSON.'); }
}

async function loadSiteProfile() {
  return JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8'));
}

export async function validateCommand(input, profile) {
  profile ||= await loadSiteProfile();
  const contracts = await loadCommandContracts();
  const { RULE_VERSION } = await loadRuleVersion();
  const envelope = contracts.CommandEnvelope.safeParse(input);
  if (!envelope.success) throw new DispatchError('COMMAND_ENVELOPE_INVALID', JSON.stringify(envelope.error.issues));
  const schema = contracts.COMMAND_PAYLOAD_SCHEMAS[envelope.data.command];
  const payload = schema?.safeParse(envelope.data.payload);
  if (!payload?.success) throw new DispatchError('COMMAND_PAYLOAD_INVALID', JSON.stringify(payload?.error?.issues || []));
  if (envelope.data.context.ruleVersion !== RULE_VERSION) {
    throw new DispatchError('RULE_VERSION_CONFLICT', `Expected ${RULE_VERSION}, received ${envelope.data.context.ruleVersion}.`);
  }
  if (!envelope.data.context.targetSite || envelope.data.context.targetSite !== profile.site?.id) {
    throw new DispatchError('TARGET_SITE_MISMATCH', 'Command targetSite does not match config/site-profile.json.');
  }
  const command = { ...envelope.data, context: { ...envelope.data.context } };
  delete command.context.preflight;
  return { command, payload: payload.data, profile };
}

export function providerReference(commandName, payload) {
  if (!PROVIDER_REFERENCE_COMMANDS.has(commandName)) return null;
  const reference = payload?.reference;
  return reference && typeof reference.provider === 'string' ? reference : null;
}

function endpointUrl(endpoint, pathname) {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
  return new URL(pathname.replace(/^\//, ''), base);
}

function jsonResponseError(status, body) {
  const code = body?.error?.code || `HTTP_${status}`;
  const message = body?.error?.message || `Request failed with HTTP ${status}.`;
  return new DispatchError(code, message);
}

async function controlRequest({ endpoint, pathname, method, secret, body, fetchImpl }) {
  const url = endpointUrl(endpoint, pathname);
  const timestamp = new Date().toISOString();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${method}.${url.pathname}`).digest('hex');
  const response = await fetchImpl(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-control-timestamp': timestamp,
      'x-control-signature': signature
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) throw jsonResponseError(response.status, result);
  return result;
}

async function commandRequest({ endpoint, command, secret, fetchImpl }) {
  const url = endpointUrl(endpoint, '/api/internal/commands');
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(command);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-command-timestamp': timestamp,
      'x-command-signature': signature
    },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) throw jsonResponseError(response.status, result);
  return result;
}

export async function runDispatch(input, options) {
  const { command, payload, profile } = await validateCommand(input, options.profile);
  const reference = providerReference(command.command, payload);
  const configuredIntake = profile.operations?.assetIntake;

  if (reference) {
    if (!configuredIntake || reference.provider !== configuredIntake.provider) {
      throw new DispatchError('ASSET_INTAKE_PROVIDER_NOT_CONFIGURED', `Provider ${reference.provider} is not the configured Asset Intake provider.`);
    }
    const readiness = await controlRequest({
      endpoint: options.endpoint,
      pathname: configuredIntake.readinessPath,
      method: 'GET',
      secret: options.controlSecret,
      fetchImpl: options.fetchImpl
    });
    if (readiness.readiness?.status !== 'READY') {
      throw new DispatchError(readiness.readiness?.code || 'ASSET_INTAKE_NOT_READY', 'Configured Asset Intake is not ready.');
    }
  }

  const preflight = await controlRequest({
    endpoint: options.endpoint,
    pathname: '/api/control/preflight',
    method: 'POST',
    secret: options.controlSecret,
    body: command,
    fetchImpl: options.fetchImpl
  });
  const receipt = preflight.preflight;
  if (!receipt?.commandDigest || !receipt?.contractVersion) {
    throw new DispatchError('PREFLIGHT_RECEIPT_INVALID', 'Preflight response did not contain a binding receipt.');
  }
  const bound = { ...command, context: { ...command.context, preflight: {
    commandDigest: receipt.commandDigest,
    contractVersion: receipt.contractVersion
  } } };
  if (options.dryRun) return { success: true, dryRun: true, command: bound };
  return commandRequest({ endpoint: options.endpoint, command: bound, secret: options.commandSecret, fetchImpl: options.fetchImpl });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = process.env.SITE_ENDPOINT;
  const controlSecret = process.env.CONTROL_READ_HMAC_SECRET;
  const commandSecret = process.env.COMMAND_HMAC_SECRET;
  if (!endpoint || !controlSecret || (!args.dryRun && !commandSecret)) {
    throw new DispatchError('DISPATCH_CONFIGURATION_MISSING', 'SITE_ENDPOINT, CONTROL_READ_HMAC_SECRET, and (unless dry-run) COMMAND_HMAC_SECRET are required.');
  }
  const command = await readCommittedCommand(args.commandFile);
  const result = await runDispatch(command, { endpoint, controlSecret, commandSecret, dryRun: args.dryRun, fetchImpl: fetch });
  console.log(JSON.stringify({ success: true, commandId: command.commandId, dryRun: args.dryRun, result: result.result || null }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({ success: false, error: { code: error.code || 'DISPATCH_FAILED', message: error.message } }));
    process.exitCode = 1;
  });
}
