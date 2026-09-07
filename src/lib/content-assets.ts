import { env } from 'cloudflare:workers';
import { resolveAssetDelivery, resolveAssetById, type AssetDelivery } from '@/server/core/assets';
import siteProfile from '../../config/site-profile.json';

export const DEFAULT_OG_IMAGE = siteProfile.defaultOgImage;
type AssociationRow = { asset_id: string; role: 'hero' | 'thumbnail' | 'ogp' | 'inline'; position: number; id: string | null; logical_asset_id: string | null; r2_key: string | null; variant: string | null };
type ResolvedAsset = AssetDelivery & { fallback?: boolean };
export type ContentMedia = { hero: ResolvedAsset | null; thumbnail: ResolvedAsset | null; ogp: ResolvedAsset | { assetId: null; logicalAssetId: null; r2Key: null; path: string; variant: 'default'; fallback: true }; inline: Map<number, ResolvedAsset>; warnings: string[] };

function delivery(row: AssociationRow): ResolvedAsset | null {
  return row.id && row.r2_key && row.variant ? resolveAssetDelivery({ id: row.id, logical_asset_id: row.logical_asset_id, r2_key: row.r2_key, variant: row.variant }) : null;
}

const missingAssetFallback = (): ResolvedAsset => ({ assetId: 'fallback', logicalAssetId: 'fallback', r2Key: '', path: DEFAULT_OG_IMAGE, variant: 'default', fallback: true });

export async function getContentMedia(contentType: string, contentId: string): Promise<ContentMedia> {
  const rows = await env.DB.prepare(`SELECT ca.asset_id, ca.role, ca.position, a.id, a.logical_asset_id, a.r2_key, a.variant FROM content_assets ca LEFT JOIN assets a ON a.id = ca.asset_id WHERE ca.content_type=? AND ca.content_id=? ORDER BY ca.position ASC`).bind(contentType, contentId).all<AssociationRow>();
  const warnings: string[] = [];
  const byRole = new Map<string, AssociationRow[]>();
  for (const row of rows.results || []) byRole.set(row.role, [...(byRole.get(row.role) || []), row]);
  const pick = (role: AssociationRow['role'], fallbacks: AssociationRow['role'][] = []) => {
    let missing = false;
    for (const candidate of [role, ...fallbacks]) for (const row of byRole.get(candidate) || []) {
      const value = delivery(row);
      if (value) return value;
      missing = true;
      warnings.push(`Missing asset ${row.asset_id} for ${contentType}/${contentId} role=${candidate} position=${row.position}`);
    }
    return missing ? missingAssetFallback() : null;
  };
  const hero = pick('hero', ['thumbnail']);
  const thumbnail = pick('thumbnail', ['hero']);
  const ogpAsset = pick('ogp', ['hero', 'thumbnail']);
  for (const warning of warnings) console.warn(`[asset-warning] ${warning}`);
  return {
    hero,
    thumbnail,
    ogp: ogpAsset || { assetId: null, logicalAssetId: null, r2Key: null, path: DEFAULT_OG_IMAGE, variant: 'default', fallback: true },
    inline: new Map((byRole.get('inline') || []).flatMap((row) => { const value = delivery(row); if (!value) { warnings.push(`Missing inline asset ${row.asset_id} for ${contentType}/${contentId} position=${row.position}`); return []; } return [[row.position, value] as [number, AssetDelivery]]; })),
    warnings
  };
}

export async function resolveContentAsset(assetId: string) {
  const asset = await resolveAssetById(assetId);
  if (!asset) console.warn(`[asset-warning] Missing asset ${assetId}`);
  return asset;
}

export async function resolveProductAsset(assetId: string) {
  const asset = await resolveAssetById(assetId);
  if (!asset) console.warn(`[asset-warning] Missing product asset ${assetId}`);
  return asset;
}
