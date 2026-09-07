import { z } from 'zod';
import { ingestAssetAsRootCommand } from '../../core/assets';
import type { CommandExecution } from '../../control-plane/job-store';
import { CommandError } from '../../core/errors';
import {
  AssetMime,
  validateFetchedAsset,
  responseBytes,
  type AssetMimeType
} from './intake-common';

const HttpUrl = z.string().url().superRefine((value, ctx) => {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) {
    ctx.addIssue({
      code: 'custom',
      message: 'WordPress media URL must use HTTP or HTTPS.'
    });
  }

  if (url.username || url.password) {
    ctx.addIssue({
      code: 'custom',
      message: 'WordPress media URL must not contain credentials.'
    });
  }
});

export const WordPressAssetReference = z.object({
  provider: z.literal('wordpress'),
  sourceId: z.string().min(1).max(200),
  sourceUrl: HttpUrl,
  expectedMimeType: AssetMime.optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedFilename: z.string().min(1).max(255).optional(),

  alt: z.string().max(1000).default(''),
  caption: z.string().max(5000).nullable().default(null),
  description: z.string().max(10000).nullable().default(null),

  width: z.number().int().positive().max(12000).nullable().optional(),
  height: z.number().int().positive().max(12000).nullable().optional()
}).strict();

export type WordPressAssetReference =
  z.infer<typeof WordPressAssetReference>;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function fail(
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): never {
  throw new CommandError(
    retryable ? 'RETRYABLE_SYSTEM_ERROR' : 'USER_CORRECTABLE',
    code,
    message,
    retryable,
    details
  );
}

function filenameFromUrl(sourceUrl: string, sourceId: string) {
  const url = new URL(sourceUrl);
  const raw = url.pathname.split('/').filter(Boolean).at(-1);

  if (!raw) return `wordpress-${sourceId}`;

  try {
    return decodeURIComponent(raw).slice(0, 255);
  } catch {
    return raw.slice(0, 255);
  }
}

function assertAllowedOrigin(
  sourceUrl: string,
  allowedOrigins: string[]
) {
  const origin = new URL(sourceUrl).origin;

  const normalized = new Set(
    allowedOrigins.map((value) => new URL(value).origin)
  );

  if (!normalized.has(origin)) {
    fail(
      'WORDPRESS_ASSET_ORIGIN_NOT_ALLOWED',
      `WordPress media origin is not allow-listed: ${origin}`
    );
  }
}

export async function fetchWordPressAsset(
  referenceInput: unknown,
  options: {
    allowedOrigins: string[];
    fetchImpl?: FetchLike;
  }
) {
  const reference =
    WordPressAssetReference.parse(referenceInput);

  if (!options.allowedOrigins?.length) {
    throw new CommandError(
      'USER_CONFIRMATION_REQUIRED',
      'WORDPRESS_ASSET_ORIGIN_ALLOWLIST_REQUIRED',
      'WordPress Asset intake requires an explicit source-origin allow-list.'
    );
  }

  assertAllowedOrigin(
    reference.sourceUrl,
    options.allowedOrigins
  );

  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;

  try {
    response = await fetchImpl(
      reference.sourceUrl,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept:
            'image/jpeg,image/png,image/webp,image/avif,application/pdf'
        }
      }
    );
  } catch (error) {
    throw new CommandError(
      'RETRYABLE_SYSTEM_ERROR',
      'WORDPRESS_ASSET_FETCH_FAILED',
      'WordPress media transfer failed.',
      true,
      {
        cause:
          error instanceof Error
            ? error.message
            : 'unknown'
      }
    );
  }

  if (
    response.status >= 300 &&
    response.status < 400
  ) {
    fail(
      'WORDPRESS_ASSET_REDIRECT_REJECTED',
      'WordPress media redirects are rejected; use the final allow-listed media URL.'
    );
  }

  if (!response.ok) {
    throw new CommandError(
      'RETRYABLE_SYSTEM_ERROR',
      'WORDPRESS_ASSET_FETCH_FAILED',
      `WordPress media transfer returned HTTP ${response.status}.`,
      response.status >= 500
    );
  }

  const contentType =
    (response.headers.get('content-type') || '')
      .split(';', 1)[0]
      .trim();

  const mimeResult = AssetMime.safeParse(contentType);

  if (!mimeResult.success) {
    fail(
      'WORDPRESS_ASSET_MIME_UNSUPPORTED',
      `Unsupported WordPress media MIME type: ${contentType || '(missing)'}`
    );
  }

  const mimeType =
    mimeResult.data as AssetMimeType;

  const bytes =
    await responseBytes(response);

  const originalFilename =
    reference.expectedFilename ||
    filenameFromUrl(
      reference.sourceUrl,
      reference.sourceId
    );

  const validated =
    await validateFetchedAsset(
      {
        expectedMimeType:
          reference.expectedMimeType,
        expectedSha256:
          reference.expectedSha256
      },
      {
        bytes,
        metadata: {
          mimeType,
          originalFilename,
          width: reference.width ?? undefined,
          height: reference.height ?? undefined,
          sourceMetadata: {
            provider: 'wordpress',
            sourceId: reference.sourceId,
            sourceUrl: reference.sourceUrl
          }
        }
      }
    );

  return {
    ...validated,
    descriptor: {
      ...validated.descriptor,
      sourceProvider: 'wordpress' as const,
      sourceId: reference.sourceId,
      alt: reference.alt,
      caption: reference.caption,
      description: reference.description,
      sourceMetadata: {
        ...validated.descriptor.sourceMetadata,
        provider: 'wordpress',
        sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl
      }
    }
  };
}

export async function ingestWordPressAsset(
  referenceInput: unknown,
  options: {
    allowedOrigins: string[];
    fetchImpl?: FetchLike;
    ingest?: typeof ingestAssetAsRootCommand;
  },
  execution: CommandExecution
) {
  const fetched =
    await fetchWordPressAsset(
      referenceInput,
      options
    );

  return (options.ingest ?? ingestAssetAsRootCommand)(
    fetched.descriptor,
    fetched.bytes,
    execution
  );
}
