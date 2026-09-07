import { z } from 'zod';
import { ingestAsset } from '../../core/assets';
import type { CommandExecution } from '../../control-plane/job-store';
import { CommandError } from '../../core/errors';
import { validateFetchedAsset, responseBytes, type AssetMimeType } from './intake-common';

const FILE_ID = /^[A-Za-z0-9_-]{3,200}$/;
export const GoogleDriveReference = z.object({
  provider: z.literal('google_drive'),
  fileId: z.string().regex(FILE_ID),
  expectedMimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']).optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedFilename: z.string().min(1).max(255).optional()
}).strict();
export type GoogleDriveReference = z.infer<typeof GoogleDriveReference>;

type DriveMetadata = { id: string; name: string; mimeType: AssetMimeType; size?: string; md5Checksum?: string; imageMediaMetadata?: { width?: number; height?: number } };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function refreshGoogleDriveAccessToken(options: { refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: FetchLike }) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, refresh_token: options.refreshToken, grant_type: 'refresh_token' });
  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  } catch (error) {
    throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'DRIVE_TOKEN_REFRESH_FAILED', 'Google Drive token refresh failed.', true, { cause: error instanceof Error ? error.message : 'unknown' });
  }
  if (!response.ok) throw new CommandError('USER_CONFIRMATION_REQUIRED', 'DRIVE_TOKEN_REFRESH_FAILED', 'Google Drive production credentials could not be refreshed.', false);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new CommandError('USER_CONFIRMATION_REQUIRED', 'DRIVE_TOKEN_REFRESH_FAILED', 'Google Drive token response did not contain an access token.', false);
  return payload.access_token;
}

export async function fetchGoogleDriveAsset(referenceInput: unknown, options: { accessToken: string; fetchImpl?: FetchLike }) {
  const reference = GoogleDriveReference.parse(referenceInput);
  if (!options.accessToken) throw new CommandError('USER_CONFIRMATION_REQUIRED', 'DRIVE_ACCESS_TOKEN_REQUIRED', 'A scoped Google Drive access token is required.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${options.accessToken}` };
  let metadataResponse: Response;
  try {
    metadataResponse = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(reference.fileId)}?fields=id,name,mimeType,size,md5Checksum,imageMediaMetadata(width,height)`, { headers });
  } catch (error) {
    throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'DRIVE_METADATA_FETCH_FAILED', 'Google Drive metadata fetch failed.', true, { cause: error instanceof Error ? error.message : 'unknown' });
  }
  if (!metadataResponse.ok) throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'DRIVE_METADATA_FETCH_FAILED', 'Google Drive metadata fetch failed.', metadataResponse.status >= 500);
  const metadata = await metadataResponse.json() as DriveMetadata;
  if (metadata.id !== reference.fileId) throw new CommandError('USER_CORRECTABLE', 'DRIVE_REFERENCE_MISMATCH', 'Google Drive returned a different file ID.');
  if (reference.expectedFilename && reference.expectedFilename !== metadata.name) throw new CommandError('USER_CORRECTABLE', 'DRIVE_FILENAME_MISMATCH', 'Google Drive filename does not match the requested reference.');
  if (metadata.size && Number(metadata.size) > 10 * 1024 * 1024) throw new CommandError('USER_CORRECTABLE', 'ASSET_SIZE_INVALID', 'Google Drive asset exceeds the maximum size.');
  let binaryResponse: Response;
  try {
    binaryResponse = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(reference.fileId)}?alt=media`, { headers });
  } catch (error) {
    throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'DRIVE_BINARY_FETCH_FAILED', 'Google Drive binary fetch failed.', true, { cause: error instanceof Error ? error.message : 'unknown' });
  }
  if (!binaryResponse.ok) throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'DRIVE_BINARY_FETCH_FAILED', 'Google Drive binary fetch failed.', binaryResponse.status >= 500);
  const bytes = await responseBytes(binaryResponse);
  const fetched = await validateFetchedAsset(reference, { bytes, metadata: { mimeType: metadata.mimeType, originalFilename: metadata.name, width: metadata.imageMediaMetadata?.width, height: metadata.imageMediaMetadata?.height, sourceMetadata: { provider: 'google_drive', sourceId: reference.fileId, providerMd5: metadata.md5Checksum ?? null, providerBytes: metadata.size ? Number(metadata.size) : null } } });
  return fetched;
}

export async function ingestGoogleDriveAsset(referenceInput: unknown, options: { accessToken: string; fetchImpl?: FetchLike; ingest?: typeof ingestAsset }, execution: CommandExecution) {
  const fetched = await fetchGoogleDriveAsset(referenceInput, options);
  return (options.ingest ?? ingestAsset)(fetched.descriptor, fetched.bytes, execution);
}

export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Provider error identifiers are short lowercase enums (invalid_grant, invalid_client).
// Anything outside that shape is dropped rather than echoed back to a caller.
const PROVIDER_ERROR_CODE = /^[a-z_]{1,64}$/;

function providerErrorCode(payload: unknown) {
  const value = (payload as { error?: unknown } | null)?.error;
  return typeof value === 'string' && PROVIDER_ERROR_CODE.test(value) ? value : undefined;
}

async function readJson(response: Response) {
  try { return await response.json() as unknown; } catch { return null; }
}

export type DriveProbeFailure = { ok: false; code: string; httpStatus?: number; providerError?: string };
export type DriveTokenProbe = { ok: true; accessToken: string } | DriveProbeFailure;
export type DriveFolderProbe = { ok: true; folderId: string; folderName: string } | DriveProbeFailure;
export type DriveListingProbe = { ok: true; hasFiles: boolean } | DriveProbeFailure;

/**
 * Read-only credential probe used by provider readiness.
 * Returns a machine-readable verdict instead of throwing, and never returns
 * the refresh token, client id or client secret it was given.
 */
export async function probeGoogleDriveAccessToken(options: { refreshToken: string; clientId: string; clientSecret: string; fetchImpl?: FetchLike }): Promise<DriveTokenProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, refresh_token: options.refreshToken, grant_type: 'refresh_token' });
  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  } catch {
    return { ok: false, code: 'DRIVE_API_UNAVAILABLE' };
  }
  const payload = await readJson(response);
  if (!response.ok) return { ok: false, code: 'DRIVE_TOKEN_REFRESH_FAILED', httpStatus: response.status, ...(providerErrorCode(payload) ? { providerError: providerErrorCode(payload) } : {}) };
  const accessToken = (payload as { access_token?: string } | null)?.access_token;
  if (!accessToken) return { ok: false, code: 'DRIVE_TOKEN_RESPONSE_INVALID', httpStatus: response.status };
  return { ok: true, accessToken };
}

/** Read-only reachability probe for the canonical Asset Intake folder. */
export async function probeGoogleDriveFolder(folderId: string, options: { accessToken: string; fetchImpl?: FetchLike }): Promise<DriveFolderProbe> {
  if (!FILE_ID.test(folderId)) return { ok: false, code: 'ASSET_INTAKE_STABLE_ID_INVALID' };
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${options.accessToken}` } });
  } catch {
    return { ok: false, code: 'DRIVE_API_UNAVAILABLE' };
  }
  if (response.status === 404) return { ok: false, code: 'DRIVE_INTAKE_FOLDER_NOT_FOUND', httpStatus: 404 };
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'DRIVE_INTAKE_FOLDER_FORBIDDEN', httpStatus: response.status };
  if (!response.ok) return { ok: false, code: 'DRIVE_API_UNAVAILABLE', httpStatus: response.status };
  const metadata = await readJson(response) as { id?: string; name?: string; mimeType?: string; trashed?: boolean } | null;
  if (!metadata || metadata.id !== folderId) return { ok: false, code: 'DRIVE_INTAKE_FOLDER_MISMATCH', httpStatus: response.status };
  if (metadata.mimeType !== DRIVE_FOLDER_MIME_TYPE) return { ok: false, code: 'ASSET_INTAKE_STABLE_ID_NOT_FOLDER', httpStatus: response.status };
  if (metadata.trashed) return { ok: false, code: 'DRIVE_INTAKE_FOLDER_TRASHED', httpStatus: response.status };
  return { ok: true, folderId, folderName: String(metadata.name ?? '') };
}

/**
 * Read-only listing probe. Proves the runtime can enumerate the folder, which a
 * metadata read alone does not establish for shared or delegated identities.
 * An empty folder is a pass: the capability is what is being verified.
 */
export async function probeGoogleDriveFolderListing(folderId: string, options: { accessToken: string; fetchImpl?: FetchLike }): Promise<DriveListingProbe> {
  if (!FILE_ID.test(folderId)) return { ok: false, code: 'ASSET_INTAKE_STABLE_ID_INVALID' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams({ q: `'${folderId}' in parents and trashed = false`, pageSize: '1', fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  let response: Response;
  try {
    response = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${query.toString()}`, { headers: { Authorization: `Bearer ${options.accessToken}` } });
  } catch {
    return { ok: false, code: 'DRIVE_API_UNAVAILABLE' };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'DRIVE_INTAKE_FOLDER_NOT_LISTABLE', httpStatus: response.status };
  if (!response.ok) return { ok: false, code: 'DRIVE_API_UNAVAILABLE', httpStatus: response.status };
  const payload = await readJson(response) as { files?: unknown[] } | null;
  if (!payload || !Array.isArray(payload.files)) return { ok: false, code: 'DRIVE_INTAKE_FOLDER_NOT_LISTABLE', httpStatus: response.status };
  return { ok: true, hasFiles: payload.files.length > 0 };
}
