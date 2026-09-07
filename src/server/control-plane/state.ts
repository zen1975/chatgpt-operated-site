import { env } from 'cloudflare:workers';
import { PageRecord, PageSectionRecord } from '../page-composition/schemas';
import { validatePageModule } from '../page-composition/registry';

type PageRow = Record<string, unknown>;
type ProductRow = Record<string, unknown>;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(secret|token|hmac|r2[_-]?key|private[_-]?url|access[_-]?token)/i.test(key))
    .map(([key, nested]) => [key, sanitize(nested)]));
}

function pageValue(row: PageRow) {
  return PageRecord.parse({
    id: row.id, slug: row.slug, title: row.title, pageType: row.page_type,
    templateProfile: row.template_profile, status: row.status, seoTitle: row.seo_title,
    seoDescription: row.seo_description, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}

function sectionValue(row: PageRow) {
  let props: unknown;
  try { props = JSON.parse(String(row.props_json)); } catch { throw new Error('CONTROL_PAGE_SECTION_PROPS_INVALID'); }
  const parsed = PageSectionRecord.parse({
    id: row.id, pageId: row.page_id, sectionType: row.section_type,
    position: row.position, variant: row.variant, props, status: row.status,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  });
  validatePageModule({ sectionType: parsed.sectionType, variant: parsed.variant, props: parsed.props });
  return { id: parsed.id, sectionType: parsed.sectionType, variant: parsed.variant, position: parsed.position, version: parsed.version, props: sanitize(parsed.props) };
}

const pageSelect = 'id,slug,title,page_type,template_profile,status,seo_title,seo_description,version,created_at,updated_at';

async function pageState(row: PageRow) {
  const page = pageValue(row);
  const sections = await env.DB.prepare(`SELECT id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at FROM page_sections WHERE page_id=? ORDER BY position,id`).bind(page.id).all<PageRow>();
  return { page: { id: page.id, slug: page.slug, title: page.title, status: page.status, version: page.version }, sections: (sections.results || []).map(sectionValue) };
}

export async function readPageById(id: string) {
  const row = await env.DB.prepare(`SELECT ${pageSelect} FROM pages WHERE id=? LIMIT 1`).bind(id).first<PageRow>();
  return row ? pageState(row) : null;
}

export async function readPageBySlug(slug: string) {
  const row = await env.DB.prepare(`SELECT ${pageSelect} FROM pages WHERE slug=? LIMIT 1`).bind(slug).first<PageRow>();
  return row ? pageState(row) : null;
}

const productSelect = 'id,slug,title,description,category,price_amount,price_currency,price_display,minimum_order_quantity,primary_asset_id,status,published_at,version,created_at,updated_at';

async function productState(row: ProductRow) {
  return {
    product: {
      id: row.id, slug: row.slug, title: row.title, status: row.status,
      version: row.version, primaryAssetId: row.primary_asset_id
    },
    assets: ((await env.DB.prepare('SELECT role,position,asset_id FROM product_assets WHERE product_id=? ORDER BY role,position').bind(row.id).all<{ role: string; position: number; asset_id: string }>()).results || [])
      .map((asset: { role: string; position: number; asset_id: string }) => ({ role: asset.role, position: asset.position, assetId: asset.asset_id }))
  };
}

export async function readProductById(id: string) {
  const row = await env.DB.prepare(`SELECT ${productSelect} FROM products WHERE id=? LIMIT 1`).bind(id).first<ProductRow>();
  return row ? productState(row) : null;
}

export async function readProductBySlug(slug: string) {
  const row = await env.DB.prepare(`SELECT ${productSelect} FROM products WHERE slug=? LIMIT 1`).bind(slug).first<ProductRow>();
  return row ? productState(row) : null;
}

export async function readRevisions(contentType: 'page' | 'product', contentId: string) {
  const rows = await env.DB.prepare('SELECT id,action,command_id,created_at FROM content_revisions WHERE content_type=? AND content_id=? ORDER BY created_at DESC,id DESC').bind(contentType, contentId).all<{ id: string; action: string; command_id: string; created_at: string }>();
  return (rows.results || []).map((revision: { id: string; action: string; command_id: string; created_at: string }) => ({ id: revision.id, action: revision.action, commandId: revision.command_id, createdAt: revision.created_at }));
}
