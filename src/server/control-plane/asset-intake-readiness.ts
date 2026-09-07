import { env } from 'cloudflare:workers';
import siteProfile from '../../../config/site-profile.json';
import { probeGoogleDriveAccessToken, probeGoogleDriveFolder, probeGoogleDriveFolderListing } from '../adapters/assets/google-drive';
import { probeServiceAccountAccessToken } from '../adapters/assets/google-service-account';

export const ASSET_INTAKE_READINESS_VERSION = 1;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';
type Check = { id: string; status: CheckStatus; code: string; detail?: Record<string, unknown> };

type IntakeProfile = { provider?: string; stableId?: string | null; displayName?: string | null; configurationStatus?: string };

/**
 * Read-only provider readiness for the canonical Asset Intake path.
 *
 * This is a gate that runs in front of the Production Accepted mutation path.
 * It never writes, and the single runtime write path never calls it. It answers
 * one question: can this Worker runtime, with the credentials it actually holds,
 * reach the Asset Intake folder named by the Repository config right now.
 *
 * Credential values are never read into the result. Only their presence, their
 * source, and the provider's own short error identifier are reported.
 */
export type CredentialSource = 'access_token' | 'refresh_token' | 'service_account';
export const CREDENTIAL_SOURCES: readonly CredentialSource[] = ['access_token', 'refresh_token', 'service_account'];

export async function assetIntakeReadiness(options: { fetchImpl?: FetchLike; credentialSource?: CredentialSource } = {}) {
  const checks: Check[] = [];
  const intake = ((siteProfile as { operations?: { assetIntake?: IntakeProfile } }).operations?.assetIntake ?? {}) as IntakeProfile;
  const provider = intake.provider ?? null;
  const stableId = intake.stableId ?? null;

  const verdict = (code: string) => {
    const failed = checks.find((check) => check.status === 'FAIL');
    return {
      readinessVersion: ASSET_INTAKE_READINESS_VERSION,
      status: failed ? 'NOT_READY' as const : 'READY' as const,
      code: failed ? failed.code : code,
      provider,
      stableId,
      displayName: intake.displayName ?? null,
      requestedCredentialSource: options.credentialSource ?? null,
      checks,
      checkedAt: new Date().toISOString(),
      sideEffects: false
    };
  };
  const fail = (id: string, code: string, detail?: Record<string, unknown>) => {
    checks.push({ id, status: 'FAIL', code, ...(detail ? { detail } : {}) });
    return verdict(code);
  };
  const pass = (id: string, code: string, detail?: Record<string, unknown>) => {
    checks.push({ id, status: 'PASS', code, ...(detail ? { detail } : {}) });
  };

  if (provider !== 'google_drive') return fail('config', 'ASSET_INTAKE_PROVIDER_UNSUPPORTED', { provider });
  if (!stableId || intake.configurationStatus !== 'configured') return fail('config', 'ASSET_INTAKE_NOT_CONFIGURED', { configurationStatus: intake.configurationStatus ?? null, stableIdPresent: Boolean(stableId) });
  pass('config', 'ASSET_INTAKE_CONFIGURED');

  // Credential resolution mirrors the precedence the mutation path uses, so a
  // readiness PASS is evidence about the credentials the command would use.
  const configured = env as typeof env & { GOOGLE_DRIVE_ACCESS_TOKEN?: string; GOOGLE_DRIVE_REFRESH_TOKEN?: string; GOOGLE_DRIVE_CLIENT_ID?: string; GOOGLE_DRIVE_CLIENT_SECRET?: string; GOOGLE_DRIVE_SA_CLIENT_EMAIL?: string; GOOGLE_DRIVE_SA_PRIVATE_KEY?: string };
  // A caller may pin the identity under test. Without it the mutation path's own
  // precedence is used, so the default verdict is always about the credential a
  // command would actually reach. Pinning exists so an alternative credential can
  // be proven before the active one is removed — deleting a Worker secret to find
  // out whether its replacement works is a one-way move.
  const requested = options.credentialSource;
  const staticToken = requested && requested !== 'access_token' ? undefined : configured.GOOGLE_DRIVE_ACCESS_TOKEN;
  const refreshable = (!requested || requested === 'refresh_token') && Boolean(configured.GOOGLE_DRIVE_REFRESH_TOKEN && configured.GOOGLE_DRIVE_CLIENT_ID && configured.GOOGLE_DRIVE_CLIENT_SECRET);
  const serviceAccount = (!requested || requested === 'service_account') && Boolean(configured.GOOGLE_DRIVE_SA_CLIENT_EMAIL && configured.GOOGLE_DRIVE_SA_PRIVATE_KEY);
  if (!staticToken && !refreshable && !serviceAccount) {
    return fail('credentials', 'DRIVE_CREDENTIALS_MISSING', {
      accessToken: Boolean(staticToken),
      refreshToken: Boolean(configured.GOOGLE_DRIVE_REFRESH_TOKEN),
      clientId: Boolean(configured.GOOGLE_DRIVE_CLIENT_ID),
      clientSecret: Boolean(configured.GOOGLE_DRIVE_CLIENT_SECRET),
      serviceAccountEmail: Boolean(configured.GOOGLE_DRIVE_SA_CLIENT_EMAIL),
      serviceAccountKey: Boolean(configured.GOOGLE_DRIVE_SA_PRIVATE_KEY),
      requested: requested ?? null
    });
  }
  // credentialSource names which identity the readiness verdict is about, so a
  // PASS can never be mistaken for evidence about a credential that is not the
  // one the mutation path would reach.
  const credentialSource = staticToken ? 'access_token' : refreshable ? 'refresh_token' : 'service_account';
  pass('credentials', 'DRIVE_CREDENTIALS_PRESENT', { credentialSource });

  let accessToken: string;
  if (staticToken) {
    checks.push({ id: 'token', status: 'SKIPPED', code: 'DRIVE_STATIC_ACCESS_TOKEN' });
    accessToken = staticToken;
  } else if (refreshable) {
    const token = await probeGoogleDriveAccessToken({
      refreshToken: configured.GOOGLE_DRIVE_REFRESH_TOKEN as string,
      clientId: configured.GOOGLE_DRIVE_CLIENT_ID as string,
      clientSecret: configured.GOOGLE_DRIVE_CLIENT_SECRET as string,
      fetchImpl: options.fetchImpl
    });
    if (!token.ok) return fail('token', token.code, { httpStatus: token.httpStatus ?? null, providerError: token.providerError ?? null });
    pass('token', 'DRIVE_TOKEN_REFRESH_OK');
    accessToken = token.accessToken;
  } else {
    const token = await probeServiceAccountAccessToken({
      clientEmail: configured.GOOGLE_DRIVE_SA_CLIENT_EMAIL as string,
      privateKey: configured.GOOGLE_DRIVE_SA_PRIVATE_KEY as string
    }, { fetchImpl: options.fetchImpl });
    if (!token.ok) return fail('token', token.code, { httpStatus: token.httpStatus ?? null, providerError: token.providerError ?? null });
    pass('token', 'DRIVE_SERVICE_ACCOUNT_TOKEN_OK');
    accessToken = token.accessToken;
  }

  const folder = await probeGoogleDriveFolder(stableId, { accessToken, fetchImpl: options.fetchImpl });
  if (!folder.ok) return fail('folder', folder.code, { httpStatus: folder.httpStatus ?? null });
  pass('folder', 'DRIVE_INTAKE_FOLDER_REACHABLE', { folderName: folder.folderName });

  const listing = await probeGoogleDriveFolderListing(stableId, { accessToken, fetchImpl: options.fetchImpl });
  if (!listing.ok) return fail('listing', listing.code, { httpStatus: listing.httpStatus ?? null });
  pass('listing', 'DRIVE_INTAKE_FOLDER_LISTABLE', { hasFiles: listing.hasFiles });

  return verdict('ASSET_INTAKE_READY');
}
