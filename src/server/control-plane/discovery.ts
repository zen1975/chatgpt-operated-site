import { env } from 'cloudflare:workers';
import { isAssetAvailable } from '../core/assets';

type Row = Record<string, unknown>;

function positiveLimit(value: string | null) {
  const parsed = Number(value || 50);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

function nextCursor(rows: Array<{ id: string }>, limit: number) {
  return rows.length === limit ? rows[rows.length - 1].id : null;
}

function assetDto(row: Row, available: boolean) {
  return {
    assetId: row.id,
    logicalAssetId: row.logical_asset_id,
    sha256: row.sha256,
    variant: row.variant,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    validationStatus: row.validation_status,
    available
  };
}

export async function discoverAssets(url: URL) {
  const limit = positiveLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor');
  const clauses = ['id IS NOT NULL'];
  const binds: unknown[] = [];
  const filters: Array<[string, string]> = [['variant', 'variant'], ['logicalAssetId', 'logical_asset_id'], ['sha256', 'sha256'], ['mimeType', 'mime_type'], ['validationStatus', 'validation_status']];
  for (const [query, column] of filters) {
    const value = url.searchParams.get(query);
    if (value) { clauses.push(`${column}=?`); binds.push(value); }
  }
  if (cursor) { clauses.push('id>?'); binds.push(cursor); }
  const rows = await env.DB.prepare(`SELECT id,logical_asset_id,sha256,variant,mime_type,width,height,bytes,validation_status,r2_key FROM assets WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`).bind(...binds, limit).all<Row>();
  const results = await Promise.all((rows.results || []).map(async (row: Row) => assetDto(row, await isAssetAvailable(row))));
  return { assets: results, nextCursor: nextCursor(results, limit) };
}

export async function discoverAsset(assetId: string) {
  const row = await env.DB.prepare('SELECT id,logical_asset_id,sha256,variant,mime_type,width,height,bytes,validation_status,r2_key FROM assets WHERE id=? LIMIT 1').bind(assetId).first<Row>();
  if (!row) return null;
  const logicalAssetId = row.logical_asset_id || row.id;
  const family = await env.DB.prepare('SELECT id,logical_asset_id,sha256,variant,mime_type,width,height,bytes,validation_status,r2_key FROM assets WHERE logical_asset_id=? OR id=? ORDER BY variant,id').bind(logicalAssetId, logicalAssetId).all<Row>();
  const availableVariants: Record<string, string> = {};
  for (const candidate of family.results || []) if (await isAssetAvailable(candidate)) availableVariants[String(candidate.variant)] = String(candidate.id);
  return { asset: { ...assetDto(row, await isAssetAvailable(row)), availableVariants } };
}

function discoveryParams(url: URL) {
  const limit = positiveLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor');
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const status = url.searchParams.get('status');
  const prefix = url.searchParams.get('prefix');
  if (status) { clauses.push('status=?'); binds.push(status); }
  if (prefix) { clauses.push('(slug LIKE ? OR title LIKE ?)'); binds.push(`${prefix}%`, `${prefix}%`); }
  if (cursor) { clauses.push('id>?'); binds.push(cursor); }
  return { limit, clauses, binds };
}

export async function discoverPages(url: URL) {
  const { limit, clauses, binds } = discoveryParams(url);
  const rows = await env.DB.prepare(`SELECT id,slug,title,status,version,page_type FROM pages${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`).bind(...binds, limit).all<Row>();
  const pages = (rows.results || []).map((row: Row) => ({ id: row.id, slug: row.slug, title: row.title, status: row.status, version: row.version, type: row.page_type }));
  return { pages, nextCursor: nextCursor(pages, limit) };
}

export async function discoverProducts(url: URL) {
  const { limit, clauses, binds } = discoveryParams(url);
  const rows = await env.DB.prepare(`SELECT id,slug,title,status,version FROM products${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`).bind(...binds, limit).all<Row>();
  const products = (rows.results || []).map((row: Row) => ({ id: row.id, slug: row.slug, title: row.title, status: row.status, version: row.version, type: 'product' }));
  return { products, nextCursor: nextCursor(products, limit) };
}

export async function discoverContent(url: URL) {
  const { limit, clauses, binds } = discoveryParams(url);
  const contentType = url.searchParams.get('contentType');
  if (contentType) { clauses.push('content_type=?'); binds.push(contentType); }
  const rows = await env.DB.prepare(`SELECT id,slug,title,status,version,content_type FROM news${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`).bind(...binds, limit).all<Row>();
  const content = (rows.results || []).map((row: Row) => ({ id: row.id, slug: row.slug, title: row.title, status: row.status, version: row.version, type: row.content_type }));
  return { content, nextCursor: nextCursor(content, limit) };
}
