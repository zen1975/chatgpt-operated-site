import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { CommandError } from './errors';
import { uuid } from '../util';
import { successStatement, fencedBatch, assertOwnedRowAffected, type CommandExecution } from '../control-plane/job-store';

const HEX_SHA256 = /^[a-f0-9]{64}$/;

export const AssetProvider = z.enum(['generated', 'google_drive', 'wordpress', 'remote_url', 'upload', 'legacy']);
export const AssetVariant = z.enum(['original', 'large', 'medium', 'thumbnail', 'ogp']);
export const AssetRole = z.enum(['hero', 'thumbnail', 'ogp', 'inline']);

export const ContentAssetAssociation = z.object({
  contentType: z.string().min(1).max(80),
  contentId: z.string().min(1).max(200),
  role: AssetRole,
  position: z.number().int().nonnegative().default(0)
}).strict();

/**
 * Canonical intake descriptor used by every future source adapter.
 * Binary transfer is intentionally not part of this descriptor. Trusted
 * intake adapters pass bytes to ingestAsset inside the Core boundary; GitHub
 * command JSON must never become a routine binary transport.
 */
export const AssetIntakeDescriptor = z.object({
  sourceProvider: AssetProvider,
  sourceId: z.string().min(1).max(512),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  expectedSha256: z.string().regex(HEX_SHA256).optional(),
  sourceMetadata: z.record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).optional().default({}),
  alt: z.string().max(500).optional().default(''),
  caption: z.string().max(1000).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  variant: AssetVariant.default('original'),
  associations: z.array(ContentAssetAssociation).max(100).default([])
}).strict();

export type AssetIntake = z.infer<typeof AssetIntakeDescriptor>;
// Transport-neutral boundary. A future streaming adapter can replace this
// alias/normalization step without changing descriptor, storage, or D1 APIs.
export type AssetBinary = Uint8Array;
export type AssetDelivery = { assetId: string; logicalAssetId: string; r2Key: string; path: string; variant: string };

type AssetBucket = typeof env.ASSETS_BUCKET;
type AssetPutOptions = Parameters<AssetBucket['put']>[2];

export function createAssetStorage(bucket: AssetBucket = env.ASSETS_BUCKET) {
  return {
    put: (key: string, body: Uint8Array, options: AssetPutOptions) => bucket.put(key, body, options),
    get: (key: string) => bucket.get(key),
    delete: (key: string) => bucket.delete(key)
  };
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf'
};

async function sha256(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assetLogicalId(digest: string) {
  return `asset_${digest}`;
}

export function assetId(digest: string, variant: string) {
  return `${assetLogicalId(digest)}_${variant}`;
}

export function assetR2Key(digest: string, variant: string, mimeType: string) {
  const extension = EXTENSIONS[mimeType];
  if (!extension) throw new CommandError('USER_CORRECTABLE', 'ASSET_MIME_UNSUPPORTED', `Unsupported asset MIME type: ${mimeType}`);
  return `assets/${digest.slice(0, 2)}/${digest}/${variant}.${extension}`;
}

export function assetDeliveryPath(r2Key: string) {
  // Keep fixed public design assets under /assets while runtime R2 media has
  // an explicit namespace and delivery endpoint.
  // Astro's project-wide trailingSlash contract applies to endpoint routes in
  // the Cloudflare adapter, so the delivery URL is emitted with its slash.
  return `/api/assets/${r2Key.split('/').map(encodeURIComponent).join('~')}/`;
}

export function resolveAssetDelivery(row: { id: string; logical_asset_id?: string | null; r2_key: string; variant: string }): AssetDelivery {
  return {
    assetId: row.id,
    logicalAssetId: row.logical_asset_id || row.id,
    r2Key: row.r2_key,
    path: assetDeliveryPath(row.r2_key),
    variant: row.variant
  };
}

/** The single trusted definition of an asset that can be used at runtime. */
export async function isAssetAvailable(row: { validation_status?: string | null; r2_key?: string | null; bytes?: number | null }) {
  if (row.validation_status !== 'validated' || !row.r2_key || Number(row.bytes) <= 0) return false;
  try { return Boolean(await env.ASSETS_BUCKET.head(row.r2_key)); } catch { return false; }
}

export async function resolveAssetById(id: string): Promise<AssetDelivery | null> {
  const row = await env.DB.prepare('SELECT id,logical_asset_id,r2_key,variant FROM assets WHERE id=? LIMIT 1').bind(id).first<{ id: string; logical_asset_id: string | null; r2_key: string; variant: string }>();
  return row ? resolveAssetDelivery(row) : null;
}

/** Detects metadata rows that have no content association. Used by local and
 * production health checks; it never mutates storage. */
export async function findOrphanAssets(limit = 100) {
  return env.DB.prepare(`SELECT a.id,a.r2_key,a.sha256,a.created_at
    FROM assets a
    LEFT JOIN content_assets ca ON ca.asset_id=a.id
    WHERE ca.asset_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM page_sections ps WHERE instr(ps.props_json, a.id) > 0)
    ORDER BY a.created_at ASC LIMIT ?`).bind(limit).all<{ id:string; r2_key:string; sha256:string|null; created_at:string }>();
}

/** Compensation for a composite content+asset command. It only removes an
 * asset that is still unassociated; an attached asset is never deleted. */
/**
 * Deliberately not implemented as an eager compensation in the command path.
 *
 * An R2 key here is content-addressed, so it is shared state rather than
 * something one attempt owns: a stale attempt deleting it can remove the object
 * a concurrent retry has just written and is about to reference, leaving a
 * committed D1 record pointing at nothing. Intake registration now travels in
 * the outer command's fenced batch, so a failed command commits no asset row at
 * all -- the worst outcome is an unreferenced content-addressed object, which
 * is inert.
 *
 * Reclaiming those objects belongs to a separate garbage-collection pass that
 * can apply a grace window and prove no D1 reference and no live execution uses
 * the key. Neither can be proven from inside a failing command.
 */


function associationStatements(asset: AssetIntake, id: string, now: string) {
  return asset.associations.map((association) => env.DB.prepare(
    `INSERT OR IGNORE INTO content_assets (content_type,content_id,asset_id,role,position,created_at) VALUES (?,?,?,?,?,?)`
  ).bind(association.contentType, association.contentId, id, association.role, association.position, now));
}

/**
 * Core-only asset mutation. R2 is written first, then one atomic D1 batch
 * persists metadata, associations, revision, and job. If D1 fails, the R2
 * object is compensating-deleted unless an existing logical asset already
 * owns the deterministic key. No logical asset is exposed without metadata.
 */
/**
 * The D1 work an intake needs, handed to whichever command owns the job.
 *
 * Intake never completes a command. A provider-backed replacement calls this,
 * then puts `statements` into its *own* final fenced batch alongside the
 * attachment, the revision and the single success transition. When intake
 * finalized the shared job itself, a nested call marked the parent command
 * successful and cleared its lease before the parent had done anything: the
 * parent's batch then failed its own fence, while lookups reported a
 * replacement that never happened.
 */
export type AssetIntakePreparation = {
  result: {
    contentType: string;
    contentId: string;
    assetId: string;
    logicalAssetId: string;
    r2Key: string;
    url: string;
    variant: string;
    reused: boolean;
  };
  statements: unknown[];
};

/**
 * Fetch-side intake: validate the bytes, derive the canonical identity, put the
 * content-addressed object, and return the D1 statements that register it.
 *
 * Performs no job completion and clears no lease.
 */
export async function prepareAssetIntake(input: unknown, bytes: AssetBinary, execution: CommandExecution): Promise<AssetIntakePreparation> {
  const commandId = execution.commandId;
  const asset = AssetIntakeDescriptor.parse(input);
  if (bytes.byteLength !== asset.bytes) throw new CommandError('USER_CORRECTABLE', 'ASSET_BYTE_COUNT_MISMATCH', 'Asset byte count does not match payload.');
  const computed = await sha256(bytes);
  if (asset.expectedSha256 && computed !== asset.expectedSha256) throw new CommandError('USER_CORRECTABLE', 'ASSET_SHA256_MISMATCH', 'Asset SHA-256 does not match payload.');

  const logicalAssetId = assetLogicalId(computed);
  const id = assetId(computed, asset.variant);
  const r2Key = assetR2Key(computed, asset.variant, asset.mimeType);
  const intakeKey = `${commandId}:${asset.variant}`;
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT id,logical_asset_id,r2_key,variant FROM assets WHERE sha256=? AND variant=? LIMIT 1').bind(computed, asset.variant).first<{id:string;logical_asset_id:string|null;r2_key:string;variant:string}>();
  const delivery = resolveAssetDelivery({ id: existing?.id || id, logical_asset_id: existing?.logical_asset_id || logicalAssetId, r2_key: r2Key, variant: asset.variant });
  const result = { contentType: 'asset', contentId: delivery.assetId, assetId: delivery.assetId, logicalAssetId, r2Key, url: delivery.path, variant: asset.variant, reused: Boolean(existing) };

  // Content-addressed: the key is the SHA-256 of these exact bytes, so a
  // concurrent attempt writing the same key writes the same object.
  await createAssetStorage().put(r2Key, bytes, {
    httpMetadata: { contentType: asset.mimeType },
    customMetadata: { sha256: computed, logicalAssetId, variant: asset.variant }
  });

  // No compensating delete on failure. The key is shared state, not owned by
  // this attempt: a stale attempt that deleted it could remove the object a
  // concurrent retry had just written and is about to reference. If the D1 side
  // never commits, the object is left as an unreferenced content-addressed
  // blob -- inert, and safe for a later garbage-collection pass that can prove
  // no D1 reference and no live execution uses the key. Eager deletion in the
  // command path cannot prove either.
  const after = JSON.stringify({ ...result, sourceProvider: asset.sourceProvider, sourceId: asset.sourceId, sourceMetadata: asset.sourceMetadata, sha256: computed, bytes: asset.bytes, mimeType: asset.mimeType });
  const registration = existing ? [] : [env.DB.prepare(
    `INSERT INTO assets (id,r2_key,original_filename,mime_type,width,height,bytes,alt,caption,description,original_asset_id,variant,created_at,source_provider,source_id,source_sha256,source_metadata_json,sha256,logical_asset_id,intake_key,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, r2Key, asset.originalFilename, asset.mimeType, asset.width ?? null, asset.height ?? null, asset.bytes, asset.alt, asset.caption ?? null, asset.description ?? null, asset.variant === 'original' ? null : assetId(computed, 'original'), asset.variant, now, asset.sourceProvider, asset.sourceId, computed, JSON.stringify({ ...asset.sourceMetadata, sourceProvider: asset.sourceProvider, sourceId: asset.sourceId, expectedSha256: asset.expectedSha256 ?? null }), computed, logicalAssetId, intakeKey, 'validated')];

  return {
    result,
    statements: [
      ...registration,
      ...associationStatements(asset, delivery.assetId, now),
      env.DB.prepare(`INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(uuid(), 'asset', delivery.assetId, existing ? 'reuse' : 'create', null, after, commandId, now)
    ]
  };
}

/**
 * Intake for a command whose *own* job this is -- currently only the top-level
 * WordPress import. It is the outer owner, so it performs the single
 * finalization itself, in one fenced batch with the registration.
 */
export async function ingestAssetAsRootCommand(input: unknown, bytes: AssetBinary, execution: CommandExecution) {
  const { result, statements } = await prepareAssetIntake(input, bytes, execution);
  const batch = await fencedBatch(execution, [...statements, successStatement(execution, result)]);
  assertOwnedRowAffected(execution, batch[batch.length - 1]);
  return result;
}
