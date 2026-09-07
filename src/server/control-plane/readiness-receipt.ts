import { env } from 'cloudflare:workers';
import { CommandError } from '../core/errors';
import { SITE_ID } from '../site-identity';

/**
 * Evidence that provider readiness was actually verified by this installation.
 *
 * The preflight receipt could not serve this purpose: it is unsigned, so any
 * caller holding the command HMAC could mint one and reach the mutation handler
 * without provider readiness ever having been checked. This receipt is signed
 * with its own secret, which the command ingress does not hold, so possessing
 * the command secret is not enough to forge readiness evidence.
 *
 * It is issued only by the control plane, and only after the shared readiness
 * implementation has actually returned READY. A caller-supplied verdict is
 * never signed.
 */

export const READINESS_RECEIPT_VERSION = 1 as const;

/** How long a receipt stays usable. Long enough to dispatch, short enough that a stale one is not a standing key. */
export const RECEIPT_TTL_MS = 10 * 60 * 1000;
/** Tolerance for clock skew between the control plane and the Worker. */
const CLOCK_SKEW_MS = 60 * 1000;

export type ReadinessReceipt = {
  receiptVersion: typeof READINESS_RECEIPT_VERSION;
  commandDigest: string;
  contractVersion: string;
  siteId: string;
  provider: string;
  readiness: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
};

export type ReadinessReceiptClaims = Omit<ReadinessReceipt, 'signature'>;

/** Stable serialization of the signed fields. Key order cannot vary. */
export function canonicalReceiptPayload(claims: ReadinessReceiptClaims) {
  return [
    `v=${claims.receiptVersion}`,
    `digest=${claims.commandDigest}`,
    `contract=${claims.contractVersion}`,
    `site=${claims.siteId}`,
    `provider=${claims.provider}`,
    `readiness=${claims.readiness}`,
    `issued=${claims.issuedAt}`,
    `expires=${claims.expiresAt}`
  ].join('\n');
}

const encoder = new TextEncoder();

async function sign(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

const receiptSecret = () => (env as typeof env & { READINESS_RECEIPT_HMAC_SECRET?: string }).READINESS_RECEIPT_HMAC_SECRET;

/**
 * Issue a receipt. Only the control plane calls this, and only with a verdict
 * the shared readiness implementation produced.
 */
export async function issueReadinessReceipt(input: { commandDigest: string; contractVersion: string; provider: string; readiness: string; now?: Date }): Promise<ReadinessReceipt> {
  const secret = receiptSecret();
  if (!secret) {
    throw new CommandError('FATAL_SYSTEM_ERROR', 'READINESS_RECEIPT_UNAVAILABLE', 'Readiness receipts are not provisioned for this installation.');
  }
  if (input.readiness !== 'READY') {
    // Defensive: a receipt exists to attest readiness, so there is no such
    // thing as one for a provider that is not ready.
    throw new CommandError('FATAL_SYSTEM_ERROR', 'READINESS_RECEIPT_NOT_READY', 'A readiness receipt cannot be issued for a provider that is not ready.');
  }

  const now = input.now ?? new Date();
  const claims: ReadinessReceiptClaims = {
    receiptVersion: READINESS_RECEIPT_VERSION,
    commandDigest: input.commandDigest,
    contractVersion: input.contractVersion,
    siteId: SITE_ID,
    provider: input.provider,
    readiness: input.readiness,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS).toISOString()
  };
  return { ...claims, signature: await sign(secret, canonicalReceiptPayload(claims)) };
}

const reject = (code: string, message: string, details?: Record<string, unknown>) =>
  new CommandError('USER_CONFIRMATION_REQUIRED', code, message, false, details);

/**
 * Verify a receipt against the command it is supposed to attest.
 *
 * Every mismatch fails closed. The signature is checked last, but nothing is
 * trusted before it: the earlier checks only decide which error to report.
 */
export async function verifyReadinessReceipt(input: {
  receipt: unknown;
  commandDigest: string;
  contractVersion: string;
  provider: string;
  now?: Date;
}) {
  const secret = receiptSecret();
  if (!secret) throw reject('READINESS_RECEIPT_UNAVAILABLE', 'Readiness receipts are not provisioned, so provider intake cannot be authorised.');

  const receipt = input.receipt as Partial<ReadinessReceipt> | null | undefined;
  if (!receipt || typeof receipt !== 'object') throw reject('READINESS_RECEIPT_REQUIRED', 'This command performs provider intake, which requires a readiness receipt.');

  if (receipt.receiptVersion !== READINESS_RECEIPT_VERSION) throw reject('READINESS_RECEIPT_VERSION_UNSUPPORTED', 'The readiness receipt version is not supported.');
  if (typeof receipt.signature !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.signature)) throw reject('READINESS_RECEIPT_MALFORMED', 'The readiness receipt signature is malformed.');

  for (const field of ['commandDigest', 'contractVersion', 'siteId', 'provider', 'readiness', 'issuedAt', 'expiresAt'] as const) {
    if (typeof receipt[field] !== 'string' || !receipt[field]) throw reject('READINESS_RECEIPT_MALFORMED', `The readiness receipt is missing ${field}.`);
  }

  if (receipt.readiness !== 'READY') throw reject('READINESS_RECEIPT_NOT_READY', 'The readiness receipt does not attest a ready provider.');
  if (receipt.siteId !== SITE_ID) throw reject('READINESS_RECEIPT_SITE_MISMATCH', 'The readiness receipt was issued for a different installation.', { attested: receipt.siteId, installation: SITE_ID });
  if (receipt.provider !== input.provider) throw reject('READINESS_RECEIPT_PROVIDER_MISMATCH', 'The readiness receipt attests a different provider than this command uses.', { attested: receipt.provider, required: input.provider });
  if (receipt.commandDigest !== input.commandDigest) throw reject('READINESS_RECEIPT_DIGEST_MISMATCH', 'The readiness receipt was issued for a different command.');
  if (receipt.contractVersion !== input.contractVersion) throw reject('READINESS_RECEIPT_CONTRACT_DRIFT', 'The readiness receipt was issued against a different contract version.', { attested: receipt.contractVersion, current: input.contractVersion });

  const now = (input.now ?? new Date()).getTime();
  const issuedAt = Date.parse(receipt.issuedAt as string);
  const expiresAt = Date.parse(receipt.expiresAt as string);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw reject('READINESS_RECEIPT_MALFORMED', 'The readiness receipt timestamps are not valid.');
  if (issuedAt > now + CLOCK_SKEW_MS) throw reject('READINESS_RECEIPT_NOT_YET_VALID', 'The readiness receipt is dated in the future.');
  if (expiresAt <= now - CLOCK_SKEW_MS) throw reject('READINESS_RECEIPT_EXPIRED', 'The readiness receipt has expired. Re-run readiness and reissue the command.');

  const expected = await sign(secret, canonicalReceiptPayload(receipt as ReadinessReceiptClaims));
  if (!safeEqual(receipt.signature, expected)) throw reject('READINESS_RECEIPT_SIGNATURE_INVALID', 'The readiness receipt signature is not valid.');

  return receipt as ReadinessReceipt;
}
