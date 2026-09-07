import { env } from 'cloudflare:workers';
import { ContentAST } from '../core/content-ast';
import { resolveAssetDelivery } from '../core/assets';
import { assertReusablePatternTree } from '../../lib/reusable-patterns';
import { extractModuleAssetReferences, validatePageModule } from './registry';
import { PageRecord, PageSectionRecord } from './schemas';

type PageRow = Record<string, unknown>;
type SectionRow = Record<string, unknown>;
export type RenderAsset = { assetId: string; path: string; variant: string; role: string };
export type RenderSection = {
  id: string;
  sectionType: string;
  variant: string;
  props: unknown;
  assets: Record<string, RenderAsset>;
  reusableBlocks?: unknown[];
  issue?: string;
};
export type PageComposition = {
  page: { id: string; slug: string; title: string; status: string; seoTitle: string | null; seoDescription: string | null; version: number };
  sections: RenderSection[];
};

function pageValues(row: PageRow) {
  return PageRecord.parse({
    id: row.id, slug: row.slug, title: row.title, pageType: row.page_type,
    templateProfile: row.template_profile, status: row.status,
    seoTitle: row.seo_title, seoDescription: row.seo_description,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  });
}

function sectionValues(row: SectionRow) {
  const parsed = PageSectionRecord.parse({
    id: row.id, pageId: row.page_id, sectionType: row.section_type,
    position: row.position, variant: row.variant, props: JSON.parse(String(row.props_json)),
    status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  });
  validatePageModule({ sectionType: parsed.sectionType, variant: parsed.variant, props: parsed.props });
  return parsed;
}

function reusableRefs(value: unknown, refs: string[] = []) {
  if (Array.isArray(value)) { for (const item of value) reusableRefs(item, refs); return refs; }
  if (!value || typeof value !== 'object') return refs;
  const object = value as Record<string, unknown>;
  if (object.type === 'reusable' && typeof object.ref === 'string') refs.push(object.ref);
  for (const item of Object.values(object)) reusableRefs(item, refs);
  return refs;
}

async function loadReusableBlocks(ref: string) {
  await assertReusablePatternTree(ref, env.DB);
  const row = await env.DB.prepare('SELECT blocks_json FROM reusable_patterns WHERE id=? OR slug=? LIMIT 1').bind(ref, ref).first<{ blocks_json: string }>();
  if (!row) throw new Error('REUSABLE_NOT_FOUND');
  return ContentAST.parse(JSON.parse(row.blocks_json));
}

async function resolveSectionAssets(sectionType: string, props: unknown) {
  const resolved: Record<string, RenderAsset> = {};
  for (const reference of extractModuleAssetReferences({ sectionType, props })) {
    const row = await env.DB.prepare("SELECT id,logical_asset_id,r2_key,variant FROM assets WHERE id=? AND validation_status='validated' AND r2_key IS NOT NULL AND bytes > 0 LIMIT 1").bind(reference.assetId).first<{ id: string; logical_asset_id: string | null; r2_key: string; variant: string }>();
    if (!row) throw new Error(`PAGE_ASSET_UNUSABLE:${reference.assetId}`);
    const delivery = resolveAssetDelivery(row);
    resolved[reference.assetPath] = { assetId: delivery.assetId, path: delivery.path, variant: delivery.variant, role: reference.role };
  }
  return resolved;
}

async function loadPageCompositionFromRow(row: PageRow): Promise<PageComposition> {
  const page = pageValues(row);
  const rows = await env.DB.prepare('SELECT id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at FROM page_sections WHERE page_id=? AND status=\'published\' ORDER BY position,id').bind(page.id).all<SectionRow>();
  const sections: RenderSection[] = [];
  for (const row of rows.results || []) {
    try {
      const section = sectionValues(row);
      const assets = await resolveSectionAssets(section.sectionType, section.props);
      const refs = section.sectionType === 'reusable' && section.props && typeof section.props === 'object' && 'ref' in section.props
        ? [String((section.props as { ref: string }).ref)] : reusableRefs(section.props);
      for (const ref of refs) await assertReusablePatternTree(ref, env.DB);
      const reusableBlocks = section.sectionType === 'reusable'
        ? await loadReusableBlocks(String((section.props as { ref: string }).ref)) : undefined;
      sections.push({ id: section.id, sectionType: section.sectionType, variant: section.variant, props: section.props, assets, reusableBlocks });
    } catch (error) {
      const issue = error instanceof Error ? error.message : 'PAGE_SECTION_RENDER_INVALID';
      sections.push({ id: String(row.id), sectionType: String(row.section_type), variant: String(row.variant || ''), props: null, assets: {}, issue });
    }
  }
  return { page: { id: page.id, slug: page.slug, title: page.title, status: page.status, seoTitle: page.seoTitle, seoDescription: page.seoDescription, version: page.version }, sections };
}

/** Load and revalidate a published Page Composition by its stable Page ID. */
export async function loadPageComposition(pageId: string): Promise<PageComposition | null> {
  const row = await env.DB.prepare("SELECT id,slug,title,page_type,template_profile,status,seo_title,seo_description,version,created_at,updated_at FROM pages WHERE id=? AND status='published' LIMIT 1").bind(pageId).first<PageRow>();
  return row ? loadPageCompositionFromRow(row) : null;
}

/** Load and revalidate a published Page Composition by its public slug. */
export async function loadPageCompositionBySlug(slug: string): Promise<PageComposition | null> {
  const row = await env.DB.prepare("SELECT id,slug,title,page_type,template_profile,status,seo_title,seo_description,version,created_at,updated_at FROM pages WHERE slug=? AND status='published' LIMIT 1").bind(slug).first<PageRow>();
  return row ? loadPageCompositionFromRow(row) : null;
}
