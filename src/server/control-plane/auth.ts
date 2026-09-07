import { env } from 'cloudflare:workers';

const encoder = new TextEncoder();

export class ControlPlaneAuthError extends Error {
  constructor(public status: 401 | 403, public code: string, message: string) { super(message); }
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Authenticate a predefined read request without granting mutation scopes. */
export async function authorizeControlRead(request: Request, scope: 'page:read' | 'product:read' | 'revision:read' | 'asset:read' | 'content:read' | 'command:read' | 'command:preflight' | 'intake:read' | readonly ('page:read' | 'product:read' | 'revision:read' | 'asset:read' | 'content:read' | 'command:read' | 'intake:read')[], allowedMethods: readonly string[] = ['GET']) {
  if (!allowedMethods.includes(request.method)) throw new ControlPlaneAuthError(401, 'CONTROL_READ_METHOD_INVALID', 'Read Control Plane only accepts its predefined read methods.');
  const timestamp = request.headers.get('x-control-timestamp') || '';
  const signature = request.headers.get('x-control-signature') || '';
  const age = Math.abs(Date.now() - Date.parse(timestamp));
  if (!timestamp || !Number.isFinite(age) || age > 5 * 60 * 1000) throw new ControlPlaneAuthError(401, 'CONTROL_READ_AUTH_INVALID', 'Read authorization is invalid or expired.');
  const secret = (env as typeof env & { CONTROL_READ_HMAC_SECRET?: string }).CONTROL_READ_HMAC_SECRET;
  if (!secret) throw new ControlPlaneAuthError(401, 'CONTROL_READ_AUTH_UNAVAILABLE', 'Read authorization is not provisioned.');
  const expected = await hmac(secret, `${timestamp}.${request.method}.${new URL(request.url).pathname}`);
  if (!safeEqual(signature, expected)) throw new ControlPlaneAuthError(401, 'CONTROL_READ_AUTH_INVALID', 'Read authorization is invalid.');
  const scopes = ((env as typeof env & { CONTROL_READ_SCOPES?: string }).CONTROL_READ_SCOPES || '').split(',').map((value) => value.trim()).filter(Boolean);
  const required = Array.isArray(scope) ? scope : [scope];
  if (!required.some((value) => scopes.includes(value)) && !scopes.includes('*')) throw new ControlPlaneAuthError(403, 'CONTROL_READ_SCOPE_REQUIRED', `Read scope is required: ${required.join(' or ')}`);
}
