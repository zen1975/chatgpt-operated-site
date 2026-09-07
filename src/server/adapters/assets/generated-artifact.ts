import { z } from 'zod';
import { ingestAsset } from '../../core/assets';
import { CommandError } from '../../core/errors';
import { validateFetchedAsset, type AssetFetchResult, type AssetMimeType } from './intake-common';

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/;
export const GeneratedArtifactReference = z.object({
  provider: z.literal('generated'),
  artifactId: z.string().regex(ARTIFACT_ID),
  expectedMimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']).optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedFilename: z.string().min(1).max(255).optional()
}).strict();
export type GeneratedArtifactReference = z.infer<typeof GeneratedArtifactReference>;

export type GeneratedArtifactFetcher = (reference: GeneratedArtifactReference) => Promise<AssetFetchResult & { metadata: AssetFetchResult['metadata'] & { mimeType: AssetMimeType } }>;

export function createGeneratedArtifactFetcher(config: { origin: string; token: string }): GeneratedArtifactFetcher {
  return async (reference) => {
    let response: Response;
    try {
      response = await fetch(`${config.origin.replace(/\/$/, '')}/artifacts/${encodeURIComponent(reference.artifactId)}`, { headers: { Authorization: `Bearer ${config.token}` } });
    } catch (error) {
      throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'GENERATED_ARTIFACT_FETCH_FAILED', 'Generated artifact transfer failed.', true, { cause: error instanceof Error ? error.message : 'unknown' });
    }
    if (!response.ok) throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'GENERATED_ARTIFACT_FETCH_FAILED', 'Generated artifact transfer failed.', response.status >= 500);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = (response.headers.get('content-type') || '').split(';', 1)[0] as AssetMimeType;
    const originalFilename = response.headers.get('x-artifact-filename') || `artifact-${reference.artifactId}`;
    const width = Number(response.headers.get('x-artifact-width') || '') || undefined;
    const height = Number(response.headers.get('x-artifact-height') || '') || undefined;
    return { bytes, metadata: { mimeType, originalFilename, width, height, sourceMetadata: { provider: 'generated', sourceId: reference.artifactId } } };
  };
}

export async function fetchGeneratedArtifact(referenceInput: unknown, options: { fetchArtifact: GeneratedArtifactFetcher }) {
  const reference = GeneratedArtifactReference.parse(referenceInput);
  let fetched: Awaited<ReturnType<GeneratedArtifactFetcher>>;
  try {
    fetched = await options.fetchArtifact(reference);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError('RETRYABLE_SYSTEM_ERROR', 'GENERATED_ARTIFACT_FETCH_FAILED', 'Generated artifact transfer failed.', true, { cause: error instanceof Error ? error.message : 'unknown' });
  }
  if (reference.expectedFilename && reference.expectedFilename !== fetched.metadata.originalFilename) throw new CommandError('USER_CORRECTABLE', 'GENERATED_ARTIFACT_FILENAME_MISMATCH', 'Generated artifact filename does not match the requested reference.');
  const validated = await validateFetchedAsset(reference, { bytes: fetched.bytes, metadata: { ...fetched.metadata, sourceMetadata: { ...fetched.metadata.sourceMetadata, provider: 'generated', sourceId: reference.artifactId } } });
  return validated;
}

export async function ingestGeneratedArtifact(referenceInput: unknown, options: { fetchArtifact: GeneratedArtifactFetcher; ingest?: typeof ingestAsset }, commandId: string) {
  const validated = await fetchGeneratedArtifact(referenceInput, options);
  return (options.ingest ?? ingestAsset)(validated.descriptor, validated.bytes, commandId);
}
