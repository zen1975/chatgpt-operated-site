export const prerender = false;
import type { APIRoute } from 'astro';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { contractVersion } from '@/server/control-plane/contracts';
import { assetIntakeReadiness, CREDENTIAL_SOURCES, type CredentialSource } from '@/server/control-plane/asset-intake-readiness';
import { issueReadinessReceipt } from '@/server/control-plane/readiness-receipt';
import { SITE_ID } from '@/server/site-identity';

// Always 200 when the evaluation itself succeeded. NOT_READY is a verdict about
// the provider, not a transport failure, and callers must read readiness.status
// rather than infer readiness from the HTTP status.
export const GET: APIRoute = async ({ request }) => {
  try {
    await authorizeControlRead(request, ['intake:read', 'asset:read']);
    // credentialSource pins which identity is under test. It only narrows the
    // check, so it can never report readiness for a credential that is absent.
    const requested = new URL(request.url).searchParams.get('credentialSource');
    if (requested && !CREDENTIAL_SOURCES.includes(requested as CredentialSource)) {
      return Response.json({ success: false, error: { code: 'CREDENTIAL_SOURCE_INVALID', message: `credentialSource must be one of: ${CREDENTIAL_SOURCES.join(', ')}` } }, { status: 422 });
    }
    const readiness = await assetIntakeReadiness({ credentialSource: (requested as CredentialSource) ?? undefined });

    // A receipt is issued only when *this* evaluation returned READY, and only
    // for the command the caller names. A verdict supplied by the caller is
    // never signed: the signature attests what this installation observed.
    const commandDigest = new URL(request.url).searchParams.get('commandDigest');
    const receipt = commandDigest && /^sha256:[a-f0-9]{64}$/.test(commandDigest) && readiness.status === 'READY' && readiness.provider
      ? await issueReadinessReceipt({ commandDigest, contractVersion: contractVersion(), provider: readiness.provider, readiness: readiness.status })
      : undefined;

    return Response.json({ success: true, siteId: SITE_ID, contractVersion: contractVersion(), readiness, ...(receipt ? { receipt } : {}) });
  } catch (error) { return controlError(error); }
};
