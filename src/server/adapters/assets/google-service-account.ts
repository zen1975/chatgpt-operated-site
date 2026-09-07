import { CommandError } from '../../core/errors';

/**
 * Google service-account credentials for server-to-server Drive access.
 *
 * A service account is its own identity, so it needs no user consent screen.
 * That removes the whole class of failure the OAuth user flow carries: no
 * publishing status, no verification, no authorized domain, and in particular
 * no refresh token that expires seven days after issue while the consent
 * screen is in testing.
 *
 * Access is granted by sharing the intake folder with the service account
 * address as a viewer. Domain-wide delegation is deliberately not used: the
 * account must see only what it was explicitly given.
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_LIFETIME_SECONDS = 3600;

export type ServiceAccountCredentials = { clientEmail: string; privateKey: string };

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Accepts the private key exactly as it appears in the downloaded JSON, where
 * newlines are escaped. Environment plumbing loses real newlines often enough
 * that both forms must work.
 */
export function normalizePrivateKey(privateKey: string) {
  return privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
}

function pemToPkcs8(privateKey: string) {
  const body = normalizePrivateKey(privateKey)
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new CommandError('USER_CONFIRMATION_REQUIRED', 'DRIVE_SERVICE_ACCOUNT_KEY_INVALID', 'The service account private key is not a PEM document.', false);
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index);
  return der;
}

async function signJwt(credentials: ServiceAccountCredentials, scope: string, issuedAt: number) {
  const claims = { iss: credentials.clientEmail, scope, aud: TOKEN_ENDPOINT, iat: issuedAt, exp: issuedAt + TOKEN_LIFETIME_SECONDS };
  const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson(claims)}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(credentials.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError('USER_CONFIRMATION_REQUIRED', 'DRIVE_SERVICE_ACCOUNT_KEY_INVALID', 'The service account private key could not be imported.', false);
  }
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

const PROVIDER_ERROR_CODE = /^[a-z_]{1,64}$/;

/**
 * Read-only probe. Mirrors probeGoogleDriveAccessToken: a machine-readable
 * verdict instead of an exception, and never the key it was given.
 */
export async function probeServiceAccountAccessToken(credentials: ServiceAccountCredentials, options: { scope?: string; fetchImpl?: FetchLike; issuedAt?: number } = {}): Promise<{ ok: true; accessToken: string } | { ok: false; code: string; httpStatus?: number; providerError?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let assertion: string;
  try {
    assertion = await signJwt(credentials, options.scope ?? DRIVE_READONLY_SCOPE, options.issuedAt ?? Math.floor(Date.now() / 1000));
  } catch {
    return { ok: false, code: 'DRIVE_SERVICE_ACCOUNT_KEY_INVALID' };
  }
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }) });
  } catch {
    return { ok: false, code: 'DRIVE_API_UNAVAILABLE' };
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  const error = (payload as { error?: unknown } | null)?.error;
  const providerError = typeof error === 'string' && PROVIDER_ERROR_CODE.test(error) ? error : undefined;
  if (!response.ok) return { ok: false, code: 'DRIVE_SERVICE_ACCOUNT_TOKEN_FAILED', httpStatus: response.status, ...(providerError ? { providerError } : {}) };
  const accessToken = (payload as { access_token?: string } | null)?.access_token;
  if (!accessToken) return { ok: false, code: 'DRIVE_SERVICE_ACCOUNT_TOKEN_INVALID', httpStatus: response.status };
  return { ok: true, accessToken };
}

/** Mutation-path variant: throws a CommandError so failures stay in the existing error contract. */
export async function getServiceAccountAccessToken(credentials: ServiceAccountCredentials, options: { scope?: string; fetchImpl?: FetchLike } = {}) {
  const probe = await probeServiceAccountAccessToken(credentials, options);
  if (probe.ok) return probe.accessToken;
  const retryable = probe.code === 'DRIVE_API_UNAVAILABLE';
  throw new CommandError(retryable ? 'RETRYABLE_SYSTEM_ERROR' : 'USER_CONFIRMATION_REQUIRED', probe.code, 'Google Drive service account credentials could not be exchanged for an access token.', retryable);
}
