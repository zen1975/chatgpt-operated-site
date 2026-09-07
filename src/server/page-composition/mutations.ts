import { env } from 'cloudflare:workers';
import { successStatement, fencedBatch, named, assertOwnedRowAffected, SUCCESS_STATEMENT_NAME, type CommandExecution, type NamedStatement, type VersionGuard } from '../control-plane/job-store';
import { CommandError } from '../core/errors';
import { uuid } from '../util';
import { extractModuleAssetReferences, getModuleAssetSlot, validatePageModule } from './registry';
import { assertSectionAllowed, resolvePageCapability, type PageCapability } from './capabilities';
import { PageRecord, PageSectionRecord, type ModuleType } from './schemas';
import { assertReusablePatternTree } from '../../lib/reusable-patterns';
import { isAssetAvailable } from '../core/assets';
import {
  CreatePagePayload, InsertPageSectionPayload, RemovePageSectionPayload, ReorderPageSectionsPayload,
  ReplacePageSectionAssetPayload, RollbackPagePayload, UpdatePagePayload, UpdatePageSectionPayload
  , InsertPageSectionItemPayload, UpdatePageSectionItemPayload, RemovePageSectionItemPayload, ReorderPageSectionItemsPayload, ReplacePageSectionItemAssetPayload
} from '../command-schema';

type PageRow = {
  id: string; slug: string; title: string; page_type: string; template_profile: string; status: string;
  seo_title: string | null; seo_description: string | null; version: number; created_at: string; updated_at: string;
};
type SectionRow = {
  id: string; page_id: string; section_type: string; position: number; variant: string | null;
  props_json: string; status: string; version: number; created_at: string; updated_at: string;
};

const POSITION_OFFSET = 1_000_000;
const PAGE_TEMPLATES = new Set(['company-default', 'standard-default', 'landing-default', 'service-default', 'contact-default', 'custom-default']);

function pageError(code: string, message: string, details?: Record<string, unknown>) {
  return new CommandError('USER_CORRECTABLE', code, message, false, details);
}

function mapPage(row: PageRow) {
  return {
    id: row.id, slug: row.slug, title: row.title, pageType: row.page_type, templateProfile: row.template_profile,
    status: row.status, seoTitle: row.seo_title, seoDescription: row.seo_description, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function parseSection(row: SectionRow) {
  if (!row.variant) throw pageError('PAGE_SECTION_VARIANT_MISSING', `Page section has no variant: ${row.id}`);
  let props: unknown;
  try { props = JSON.parse(row.props_json); } catch { throw pageError('PAGE_SECTION_PROPS_INVALID', `Page section props are not valid JSON: ${row.id}`); }
  validatePageModule({ sectionType: row.section_type, variant: row.variant, props });
  return {
    id: row.id, pageId: row.page_id, sectionType: row.section_type as ModuleType, position: row.position,
    variant: row.variant, props, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function getPage(pageId: string) {
  const row = await env.DB.prepare('SELECT id,slug,title,page_type,template_profile,status,seo_title,seo_description,version,created_at,updated_at FROM pages WHERE id=? LIMIT 1').bind(pageId).first<PageRow>();
  if (!row) throw pageError('PAGE_NOT_FOUND', 'Page was not found.');
  return row;
}

type PageSection = ReturnType<typeof parseSection>;

// Returns a preparation, not a finished asset: the statements travel with it so
// the page command can commit them in its own fenced batch and remain the only
// writer that finalizes the job.
type PageAssetResolver = (reference: unknown, role: string) => Promise<{ result: { assetId: string; reused: boolean }; statements: D1PreparedStatement[] }>;

async function getSections(pageId: string): Promise<PageSection[]> {
  const rows = await env.DB.prepare('SELECT id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at FROM page_sections WHERE page_id=? ORDER BY position,id').bind(pageId).all<SectionRow>();
  return (rows.results || []).map(parseSection);
}

function checkPageVersion(row: PageRow, expectedVersion: number) {
  if (row.version !== expectedVersion) throw new CommandError('CONFLICT', 'PAGE_VERSION_CONFLICT', 'Page version does not match expectedVersion.', false, { expectedVersion, currentVersion: row.version });
}

function checkSectionVersion(row: { version: number }, expectedVersion: number) {
  if (row.version !== expectedVersion) throw new CommandError('CONFLICT', 'PAGE_SECTION_VERSION_CONFLICT', 'Page section version does not match expectedSectionVersion.', false, { expectedSectionVersion: expectedVersion, currentVersion: row.version });
}

function policyFor(page: PageRow): PageCapability {
  try { return resolvePageCapability(page.slug); }
  catch { throw pageError('PAGE_CAPABILITY_POLICY_MISSING', `No capability policy is configured for page: ${page.slug}`); }
}

function requirePermission(policy: PageCapability, permission: keyof PageCapability['permissions']) {
  if (!policy.permissions[permission]) throw pageError('PAGE_OPERATION_FORBIDDEN', `Page operation is disabled by capability policy: ${permission}`);
}

function assertModulePolicy(policy: PageCapability, sectionType: string, sectionId?: string) {
  try { assertSectionAllowed(policy, sectionType, sectionId); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('PAGE_SECTION_LOCKED:')) throw pageError('PAGE_SECTION_LOCKED', message.slice('PAGE_SECTION_LOCKED:'.length));
    throw pageError('PAGE_SECTION_TYPE_NOT_ALLOWED', message.slice('PAGE_SECTION_TYPE_NOT_ALLOWED:'.length));
  }
}

function validateSection(policy: PageCapability, section: { sectionType: string; variant: string; props: unknown }, sectionId?: string) {
  assertModulePolicy(policy, section.sectionType, sectionId);
  return validatePageModule(section);
}

function collectSectionAssetIds(sections: Array<{ sectionType: string; props: unknown }>): string[] {
  return [...new Set(sections.flatMap((section) => extractModuleAssetReferences(section).map((reference) => reference.assetId)))].sort();
}

async function assertAssetsExist(sectionType: string, props: unknown, exempt: ReadonlySet<string> = new Set()) {
  const referenced = extractModuleAssetReferences({ sectionType, props }).map((reference) => reference.assetId);
  // An asset registered by this same fenced batch cannot be found in D1 yet.
  // Only that exact id is exempt: every other slot is validated as usual, or a
  // provider-backed replacement of one slot would stop checking the rest.
  const assetIds = referenced.filter((id) => !exempt.has(id));
  if (!assetIds.length) return referenced;
  const rows = await env.DB.prepare(`SELECT id,r2_key,validation_status,bytes FROM assets WHERE id IN (${assetIds.map(() => '?').join(',')})`).bind(...assetIds).all<{ id: string; r2_key: string | null; validation_status: string | null; bytes: number | null }>();
  const usable = await Promise.all((rows.results || []).map(async (row: { id: string; r2_key: string | null; validation_status: string | null; bytes: number | null }) => ({ row, available: await isAssetAvailable(row) })));
  const found = new Set(usable.filter((item: { available: boolean }) => item.available).map((item: { row: { id: string } }) => item.row.id));
  const missing = [...new Set(assetIds)].filter((id) => !found.has(id));
  if (missing.length) throw pageError('PAGE_ASSET_UNUSABLE', 'One or more page module assets are missing or unavailable.', { missing });
  return [...new Set(referenced)];
}

async function assertReusableReferences(value: unknown, assetIds: string[] = []): Promise<string[]> {
  if (Array.isArray(value)) {
    for (const item of value) await assertReusableReferences(item, assetIds);
    return assetIds;
  }
  if (!value || typeof value !== 'object') return assetIds;
  const object = value as Record<string, unknown>;
  if (object.type === 'reusable' && typeof object.ref === 'string') {
    assetIds.push(...await assertReusablePatternTree(object.ref, env.DB));
  }
  for (const item of Object.values(object)) await assertReusableReferences(item, assetIds);
  return assetIds;
}

/**
 * Validate every asset a section references.
 *
 * `exempt` names assets being registered by the caller's own fenced batch, so
 * they are not yet visible in D1. Nothing else is skipped -- a provider-backed
 * replacement of one slot must still prove the other slots, and any reusable
 * pattern it pulls in, are usable.
 */
async function assertSectionAssets(sectionType: string, props: unknown, exempt: ReadonlySet<string> = new Set()) {
  const direct = await assertAssetsExist(sectionType, props, exempt);
  const reusable = sectionType === 'reusable' && props && typeof props === 'object' && !Array.isArray(props) && typeof (props as { ref?: unknown }).ref === 'string'
    ? await assertReusablePatternTree((props as { ref: string }).ref, env.DB)
    : await assertReusableReferences(props);
  if (reusable.length) {
    const pending = reusable.filter((id) => !exempt.has(id));
    if (!pending.length) return [...new Set([...direct, ...reusable])];
    const rows = await env.DB.prepare(`SELECT id,r2_key,validation_status,bytes FROM assets WHERE id IN (${pending.map(() => '?').join(',')})`).bind(...pending).all<{ id: string; r2_key: string | null; validation_status: string | null; bytes: number | null }>();
    const usable = await Promise.all((rows.results || []).map(async (row: { id: string; r2_key: string | null; validation_status: string | null; bytes: number | null }) => ({ row, available: await isAssetAvailable(row) })));
    const found = new Set(usable.filter((item: { available: boolean }) => item.available).map((item: { row: { id: string } }) => item.row.id));
    const missing = [...new Set(pending)].filter((id) => !found.has(id));
    if (missing.length) throw pageError('PAGE_ASSET_UNUSABLE', 'A reusable pattern references a missing or unavailable Asset.', { missing });
  }
  return [...new Set([...direct, ...reusable])];
}

function snapshot(page: PageRow | ReturnType<typeof mapPage>, sections: ReturnType<typeof parseSection>[], version?: number) {
  const normalizedPage = 'pageType' in page ? page : mapPage(page);
  const pageSnapshot = { ...normalizedPage, ...(version === undefined ? {} : { version }) };
  return { page: pageSnapshot, sections, assetIds: collectSectionAssetIds(sections) };
}

async function validateSnapshot(value: unknown, pageId: string) {
  if (!value || typeof value !== 'object') throw pageError('PAGE_REVISION_INVALID', 'Page revision snapshot is invalid.');
  const input = value as { page?: unknown; sections?: unknown };
  const page = PageRecord.parse(input.page);
  if (page.id !== pageId) throw pageError('PAGE_REVISION_INVALID', 'Page revision belongs to another page.');
  if (!Array.isArray(input.sections)) throw pageError('PAGE_REVISION_INVALID', 'Page revision sections are invalid.');
  const sections = input.sections.map((section) => {
    const parsed = PageSectionRecord.parse(section);
    if (parsed.pageId !== pageId) throw pageError('PAGE_REVISION_INVALID', 'Page revision contains a cross-page section.');
    validatePageModule({ sectionType: parsed.sectionType, variant: parsed.variant, props: parsed.props });
    return parsed;
  });
  const ids = sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) throw pageError('PAGE_REVISION_INVALID', 'Page revision contains duplicate section IDs.');
  for (const section of sections) await assertSectionAssets(section.sectionType, section.props);
  return { page, sections };
}

function pageUpdateStatement(page: PageRow, expectedVersion: number, updates: string, binds: unknown[], nextVersion: number, now: string) {
  return env.DB.prepare(`UPDATE pages SET ${updates ? `${updates}, ` : ''}version=?,updated_at=? WHERE id=? AND version=?`).bind(...binds, nextVersion, now, page.id, expectedVersion);
}

function revisionStatement(commandId: string, pageId: string, action: string, before: unknown, after: unknown, now: string) {
  return env.DB.prepare('INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(uuid(), 'page', pageId, action, JSON.stringify(before), JSON.stringify(after), commandId, now);
}

function jobStatement(execution: CommandExecution, result: unknown, now: string) {
  return successStatement(execution, result, now);
}

function positionStatements(pageId: string, sections: Array<{ id: string; position: number }>) {
  return [
    env.DB.prepare('UPDATE page_sections SET position=position+? WHERE page_id=?').bind(POSITION_OFFSET, pageId),
    ...sections.map((section) => env.DB.prepare('UPDATE page_sections SET position=? WHERE id=? AND page_id=?').bind(section.position, section.id, pageId))
  ];
}

const namedMutations = (statements: D1PreparedStatement[]): NamedStatement[] => statements.map((statement, index) => named(`mutation-${index}`, statement));

async function commitPageMutation(execution: CommandExecution, page: PageRow, expectedVersion: number, action: string, before: unknown, after: unknown, statements: NamedStatement[], result: unknown, sectionGuard?: VersionGuard) {
  const now = new Date().toISOString();
  // The page version is a fence, so a page that moved on aborts the batch
  // rather than being detected after everything else has committed.
  const results = await fencedBatch(execution, [
    ...statements,
    named('revision', revisionStatement(execution.commandId, page.id, action, before, after, now)),
    named(SUCCESS_STATEMENT_NAME, jobStatement(execution, result, now))
  ], { versionGuards: [{ subject: 'pages', expectedVersion, keys: [page.id, expectedVersion] }, ...(sectionGuard ? [sectionGuard] : [])] });

  assertOwnedRowAffected(execution, results);
  return result;
}

function sectionById(sections: PageSection[], sectionId: string) {
  const section = sections.find((candidate) => candidate.id === sectionId);
  if (!section) throw pageError('PAGE_SECTION_NOT_FOUND', 'Page section was not found.');
  return section;
}

function cloneWithAssetPath(value: unknown, path: string, assetId: string): unknown {
  const clone = structuredClone(value);
  if (path === 'assetId') {
    if (!clone || typeof clone !== 'object' || Array.isArray(clone)) throw pageError('PAGE_ASSET_PATH_INVALID', 'The module does not expose the requested asset path.');
    (clone as { assetId: string }).assetId = assetId;
    return clone;
  }
  const match = /^items\[(\d+)\]\.assetId$/.exec(path);
  if (!match || !clone || typeof clone !== 'object' || Array.isArray(clone)) throw pageError('PAGE_ASSET_PATH_INVALID', 'The module does not expose the requested asset path.');
  const items = (clone as { items?: Array<{ assetId?: string }> }).items;
  const index = Number(match[1]);
  if (!items?.[index] || typeof items[index] !== 'object') throw pageError('PAGE_ASSET_PATH_INVALID', 'The module does not expose the requested asset path.');
  items[index].assetId = assetId;
  return clone;
}

const ITEM_MODULES = new Set(['cardGrid', 'faq', 'timeline', 'stats', 'logoCloud', 'contentList', 'table']);
function sectionItems(section: PageSection): Array<Record<string, unknown>> {
  if (!ITEM_MODULES.has(section.sectionType) || !section.props || typeof section.props !== 'object' || Array.isArray(section.props)) throw pageError('PAGE_ITEM_MODULE_UNSUPPORTED', `Section type does not expose stable items: ${section.sectionType}`);
  const items = section.sectionType === 'table' ? (section.props as { rows?: unknown }).rows : (section.props as { items?: unknown }).items;
  if (!Array.isArray(items)) throw pageError('PAGE_ITEM_LIST_INVALID', 'Section items are invalid.');
  if (section.sectionType === 'table' && items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof (item as { id?: unknown }).id !== 'string' || !Array.isArray((item as { cells?: unknown }).cells))) throw pageError('PAGE_TABLE_STABLE_ID_REQUIRED', 'Table rows must use stable IDs and cells.');
  if (items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof (item as { id?: unknown }).id !== 'string')) throw pageError('PAGE_ITEM_ID_MISSING', 'Every mutable section item must have a stable id.');
  if (new Set(items.map((item) => String((item as { id: string }).id))).size !== items.length) throw pageError('PAGE_ITEM_DUPLICATE_ID', 'Section item IDs must be unique.');
  return items as Array<Record<string, unknown>>;
}

function itemById(items: Array<Record<string, unknown>>, itemId: string) { const item = items.find((candidate) => candidate.id === itemId); if (!item) throw pageError('PAGE_ITEM_NOT_FOUND', 'The requested section item was not found.'); return item; }

async function executePageSectionItemCommand(execution: CommandExecution, input: unknown) {
  const command = execution.commandType;
  const commandId = execution.commandId;
  const payload: any = command === 'insert_page_section_item' ? InsertPageSectionItemPayload.parse(input) : command === 'update_page_section_item' ? UpdatePageSectionItemPayload.parse(input) : command === 'remove_page_section_item' ? RemovePageSectionItemPayload.parse(input) : command === 'reorder_page_section_items' ? ReorderPageSectionItemsPayload.parse(input) : ReplacePageSectionItemAssetPayload.parse(input);
  const page = await getPage(payload.pageId), current = await getSections(page.id), section = sectionById(current, payload.sectionId), policy = policyFor(page);
  requirePermission(policy, 'update'); checkPageVersion(page, payload.expectedVersion); checkSectionVersion(section, payload.expectedSectionVersion); assertModulePolicy(policy, section.sectionType, section.id);
  const items = sectionItems(section);
  let nextItems: Array<Record<string, unknown>> = items;
  if (command === 'insert_page_section_item') {
    const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item) ? { ...(payload.item as Record<string, unknown>), id: `${section.id}:item:${uuid()}` } : null;
    if (!item) throw pageError('PAGE_ITEM_INVALID', 'Inserted section item must be an object.');
    nextItems = [...items.slice(0, Math.min(payload.position, items.length)), item, ...items.slice(Math.min(payload.position, items.length))];
  } else if (command === 'update_page_section_item') {
    const existing = itemById(items, payload.itemId); const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item) ? { ...(payload.item as Record<string, unknown>), id: existing.id } : null; if (!item) throw pageError('PAGE_ITEM_INVALID', 'Updated section item must be an object.'); nextItems = items.map((candidate) => candidate.id === payload.itemId ? item : candidate);
  } else if (command === 'remove_page_section_item') {
    itemById(items, payload.itemId); if (items.length <= 1) throw pageError('PAGE_ITEM_LAST_REJECTED', 'A section must retain at least one item.'); nextItems = items.filter((candidate) => candidate.id !== payload.itemId);
  } else if (command === 'reorder_page_section_items') {
    if (new Set(payload.itemIds).size !== payload.itemIds.length || payload.itemIds.length !== items.length || items.some((item) => !payload.itemIds.includes(String(item.id)))) throw pageError('PAGE_ITEM_SET_MISMATCH', 'Reorder must contain the complete current item ID set.'); nextItems = payload.itemIds.map((id: string) => itemById(items, id));
  } else if (command === 'replace_page_section_item_asset') {
    if (section.sectionType === 'table') throw pageError('PAGE_ITEM_ASSET_SLOT_INVALID', 'Table rows do not expose an Asset slot.');
    const item = itemById(items, payload.itemId); const sectionProps = section.props as Record<string, unknown>; if (!('assetId' in item) && section.sectionType !== 'logoCloud' && section.sectionType !== 'cardGrid' && section.sectionType !== 'contentList') throw pageError('PAGE_ITEM_ASSET_SLOT_INVALID', 'The section item has no registered Asset slot.'); await assertAssetsExist(section.sectionType, { ...sectionProps, items: [item] }); if (!getModuleAssetSlot(section.sectionType, 'items[0].assetId')) throw pageError('PAGE_ITEM_ASSET_SLOT_INVALID', 'The section item Asset slot is not registered.'); await assertAssetsExist(section.sectionType, { ...sectionProps, items: items.map((candidate) => candidate.id === item.id ? { ...candidate, assetId: payload.assetId } : candidate) }); nextItems = items.map((candidate) => candidate.id === item.id ? { ...candidate, assetId: payload.assetId } : candidate);
  }
  const props = section.sectionType === 'table' ? { ...(section.props as Record<string, unknown>), rows: nextItems } : { ...(section.props as Record<string, unknown>), items: nextItems }; validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props }, section.id); await assertSectionAssets(section.sectionType, props);
  const now = new Date().toISOString(), nextVersion = page.version + 1, nextSectionVersion = section.version + 1, updated = { ...section, props, version: nextSectionVersion, updatedAt: now }, sections = current.map((candidate) => candidate.id === section.id ? updated : candidate), before = snapshot(page, current), after = snapshot({ ...page, updated_at: now }, sections, nextVersion), result = { pageId: page.id, sectionId: section.id, version: nextVersion, sectionVersion: nextSectionVersion, action: command };
  return commitPageMutation(execution, page, payload.expectedVersion, command, before, after, namedMutations([pageUpdateStatement(page, payload.expectedVersion, '', [], nextVersion, now), env.DB.prepare('UPDATE page_sections SET props_json=?,version=?,updated_at=? WHERE id=? AND page_id=? AND version=?').bind(JSON.stringify(props), nextSectionVersion, now, section.id, page.id, payload.expectedSectionVersion)]), result, { subject: 'page_sections', expectedVersion: payload.expectedSectionVersion, keys: [section.id, payload.expectedSectionVersion] })
}

/**
 * Read-only validation shared by the Control Plane preflight and the page
 * mutation boundary. It deliberately stops before provider intake, D1 batch,
 * revision/job creation, or any R2 operation.
 */
export async function preflightPageCommand(command: string, input: unknown) {
  if (command === 'create_page') {
    const payload = CreatePagePayload.parse(input);
    if (!PAGE_TEMPLATES.has(payload.templateProfile)) throw pageError('INVALID_PAGE_TEMPLATE_PROFILE', `Page template profile is not registered: ${payload.templateProfile}`);
    const policy = resolvePageCapability(payload.slug);
    requirePermission(policy, 'insert');
    for (const [index, section] of payload.sections.entries()) {
      validateSection(policy, section, section.id || `${payload.slug}:section:${index + 1}`);
      await assertSectionAssets(section.sectionType, section.props);
    }
    return { ok: true, command, target: { slug: payload.slug }, mutation: false };
  }

  const pageCommands = new Set(['update_page', 'insert_page_section', 'update_page_section', 'remove_page_section', 'reorder_page_sections', 'replace_page_section_asset', 'rollback_page']);
  if (pageCommands.has(command)) {
    const payload: any = command === 'update_page' ? UpdatePagePayload.parse(input)
      : command === 'insert_page_section' ? InsertPageSectionPayload.parse(input)
      : command === 'update_page_section' ? UpdatePageSectionPayload.parse(input)
      : command === 'remove_page_section' ? RemovePageSectionPayload.parse(input)
      : command === 'reorder_page_sections' ? ReorderPageSectionsPayload.parse(input)
      : command === 'replace_page_section_asset' ? ReplacePageSectionAssetPayload.parse(input)
      : RollbackPagePayload.parse(input);
    const page = await getPage(payload.pageId);
    const current = await getSections(page.id);
    const policy = policyFor(page);
    checkPageVersion(page, payload.expectedVersion);
    if (command === 'update_page') { requirePermission(policy, 'updatePage'); }
    if (command === 'insert_page_section') {
      requirePermission(policy, 'insert');
      validateSection(policy, payload, payload.sectionId);
      await assertSectionAssets(payload.sectionType, payload.props);
    }
    if (command === 'update_page_section') {
      const section = sectionById(current, payload.sectionId);
      requirePermission(policy, 'update'); checkSectionVersion(section, payload.expectedSectionVersion);
      validateSection(policy, payload, section.id); await assertSectionAssets(payload.sectionType, payload.props);
    }
    if (command === 'remove_page_section') {
      const section = sectionById(current, payload.sectionId);
      requirePermission(policy, 'remove'); checkSectionVersion(section, payload.expectedSectionVersion); assertModulePolicy(policy, section.sectionType, section.id);
    }
    if (command === 'reorder_page_sections') {
      requirePermission(policy, 'reorder');
      const ids = current.map((section) => section.id);
      if (new Set(payload.sectionIds).size !== payload.sectionIds.length || payload.sectionIds.length !== ids.length || ids.some((id) => !payload.sectionIds.includes(id))) throw pageError('PAGE_REORDER_SECTION_SET_MISMATCH', 'Reorder payload must contain the complete current section ID set.');
    }
    if (command === 'replace_page_section_asset') {
      const section = sectionById(current, payload.sectionId);
      requirePermission(policy, 'replaceAsset'); checkSectionVersion(section, payload.expectedSectionVersion); assertModulePolicy(policy, section.sectionType, section.id);
      const slot = getModuleAssetSlot(section.sectionType, payload.assetPath);
      if (!slot) throw pageError('PAGE_ASSET_PATH_INVALID', `Asset path is not registered for ${section.sectionType}: ${payload.assetPath}`);
      if (payload.reference && slot.role !== payload.reference.intendedRole) throw pageError('PAGE_ASSET_ROLE_MISMATCH', 'Asset reference role does not match the registered Page module slot.');
      const assetId = payload.assetId || 'asset_' + '0'.repeat(64) + '_original';
      if (payload.assetId) {
        const asset = await env.DB.prepare("SELECT id FROM assets WHERE id=? AND validation_status='validated' AND r2_key IS NOT NULL AND bytes > 0 LIMIT 1").bind(assetId).first<{ id: string }>();
        if (!asset) throw pageError('PAGE_ASSET_UNUSABLE', 'The requested Asset is missing or unavailable.');
      }
      const props = cloneWithAssetPath(section.props, payload.assetPath, assetId);
      validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props }, section.id);
      if (payload.assetId) await assertSectionAssets(section.sectionType, props);
    }
    if (command === 'rollback_page') {
      requirePermission(policy, 'rollback');
      const revision = await env.DB.prepare('SELECT id,after_json FROM content_revisions WHERE id=? AND content_type=? AND content_id=? LIMIT 1').bind(payload.revisionId, 'page', page.id).first<{ id: string; after_json: string | null }>();
      if (!revision?.after_json) throw pageError('PAGE_REVISION_NOT_FOUND', 'The requested page revision was not found.');
      let raw: unknown; try { raw = JSON.parse(revision.after_json); } catch { throw pageError('PAGE_REVISION_INVALID', 'The requested page revision is not valid JSON.'); }
      const restored = await validateSnapshot(raw, page.id);
      for (const section of restored.sections) validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props: section.props }, section.id);
    }
    return { ok: true, command, target: { pageId: page.id }, currentVersion: page.version, mutation: false };
  }

  const itemCommands = new Set(['insert_page_section_item', 'update_page_section_item', 'remove_page_section_item', 'reorder_page_section_items', 'replace_page_section_item_asset']);
  if (itemCommands.has(command)) {
    const payload: any = command === 'insert_page_section_item' ? InsertPageSectionItemPayload.parse(input) : command === 'update_page_section_item' ? UpdatePageSectionItemPayload.parse(input) : command === 'remove_page_section_item' ? RemovePageSectionItemPayload.parse(input) : command === 'reorder_page_section_items' ? ReorderPageSectionItemsPayload.parse(input) : ReplacePageSectionItemAssetPayload.parse(input);
    const page = await getPage(payload.pageId), current = await getSections(page.id), section = sectionById(current, payload.sectionId), policy = policyFor(page);
    requirePermission(policy, 'update'); checkPageVersion(page, payload.expectedVersion); checkSectionVersion(section, payload.expectedSectionVersion); assertModulePolicy(policy, section.sectionType, section.id);
    const items = sectionItems(section);
    if (command === 'insert_page_section_item') {
      const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item) ? { ...(payload.item as Record<string, unknown>), id: '__preflight_item__' } : null;
      if (!item) throw pageError('PAGE_ITEM_INVALID', 'Inserted section item must be an object.');
      const props = section.sectionType === 'table' ? { ...(section.props as Record<string, unknown>), rows: [...items.slice(0, Math.min(payload.position, items.length)), item, ...items.slice(Math.min(payload.position, items.length))] } : { ...(section.props as Record<string, unknown>), items: [...items.slice(0, Math.min(payload.position, items.length)), item, ...items.slice(Math.min(payload.position, items.length))] };
      validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props }, section.id); await assertSectionAssets(section.sectionType, props);
    } else if (command === 'update_page_section_item') {
      const existing = itemById(items, payload.itemId);
      const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item) ? { ...(payload.item as Record<string, unknown>), id: existing.id } : null;
      if (!item) throw pageError('PAGE_ITEM_INVALID', 'Updated section item must be an object.');
      const next = items.map((candidate) => candidate.id === payload.itemId ? item : candidate);
      const props = section.sectionType === 'table' ? { ...(section.props as Record<string, unknown>), rows: next } : { ...(section.props as Record<string, unknown>), items: next };
      validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props }, section.id); await assertSectionAssets(section.sectionType, props);
    } else if (command === 'remove_page_section_item') {
      itemById(items, payload.itemId); if (items.length <= 1) throw pageError('PAGE_ITEM_LAST_REJECTED', 'A section must retain at least one item.');
    } else if (command === 'reorder_page_section_items') {
      if (new Set(payload.itemIds).size !== payload.itemIds.length || payload.itemIds.length !== items.length || items.some((item) => !payload.itemIds.includes(String(item.id)))) throw pageError('PAGE_ITEM_SET_MISMATCH', 'Reorder must contain the complete current item ID set.');
    } else {
      const item = itemById(items, payload.itemId);
      if (section.sectionType === 'table' || !getModuleAssetSlot(section.sectionType, 'items[0].assetId')) throw pageError('PAGE_ITEM_ASSET_SLOT_INVALID', 'The section item Asset slot is not registered.');
      const next = items.map((candidate) => candidate.id === item.id ? { ...candidate, assetId: payload.assetId } : candidate);
      const props = { ...(section.props as Record<string, unknown>), items: next };
      validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props }, section.id); await assertSectionAssets(section.sectionType, props);
    }
    return { ok: true, command, target: { pageId: page.id, sectionId: section.id }, currentVersion: page.version, currentSectionVersion: section.version, mutation: false };
  }
  throw pageError('PREFLIGHT_COMMAND_UNSUPPORTED', `Preflight is not implemented for command: ${command}`);
}

export async function executePageCommand(execution: CommandExecution, input: unknown, options: { resolveAssetReference?: PageAssetResolver } = {}) {
  const command = execution.commandType;
  const commandId = execution.commandId;
  if (command === 'insert_page_section_item' || command === 'update_page_section_item' || command === 'remove_page_section_item' || command === 'reorder_page_section_items' || command === 'replace_page_section_item_asset') return executePageSectionItemCommand(execution, input);
  if (command === 'create_page') {
    const payload = CreatePagePayload.parse(input);
    if (!PAGE_TEMPLATES.has(payload.templateProfile)) throw pageError('INVALID_PAGE_TEMPLATE_PROFILE', `Page template profile is not registered: ${payload.templateProfile}`);
    let policy: PageCapability;
    try { policy = resolvePageCapability(payload.slug); } catch { throw pageError('PAGE_CAPABILITY_POLICY_MISSING', `No capability policy is configured for page: ${payload.slug}`); }
    requirePermission(policy, 'insert');
    const pageId = uuid();
    const now = new Date().toISOString();
    const sections = payload.sections.map((section, index) => {
      const id = section.id || `${pageId}:section:${index + 1}`;
      validateSection(policy, section, id);
      return { id, pageId, sectionType: section.sectionType as ModuleType, position: index, variant: section.variant, props: section.props, status: 'published' as const, version: 1, createdAt: now, updatedAt: now };
    });
    for (const section of sections) await assertSectionAssets(section.sectionType, section.props);
    const page = { id: pageId, slug: payload.slug, title: payload.title, pageType: payload.pageType, templateProfile: payload.templateProfile, status: payload.status, seoTitle: payload.seoTitle, seoDescription: payload.seoDescription, version: 1, createdAt: now, updatedAt: now };
    const after = { page, sections, assetIds: collectSectionAssetIds(sections) };
    const result = { pageId, slug: page.slug, version: 1, action: 'create_page' };
    const statements: D1PreparedStatement[] = [env.DB.prepare('INSERT INTO pages (id,slug,title,page_type,template_profile,status,seo_title,seo_description,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(page.id, page.slug, page.title, page.pageType, page.templateProfile, page.status, page.seoTitle, page.seoDescription, page.version, now, now)];
    for (const section of sections) statements.push(env.DB.prepare('INSERT INTO page_sections (id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(section.id, section.pageId, section.sectionType, section.position, section.variant, JSON.stringify(section.props), section.status, section.version, now, now));
    statements.push(revisionStatement(commandId, page.id, 'create_page', null, after, now), jobStatement(execution, result, now));
    const results = await fencedBatch(execution, statements.map((statement, index) => named(`create-page-${index}`, statement)));
    assertOwnedRowAffected(execution, results);
    return result;
  }

  if (command === 'update_page') {
    const payload = UpdatePagePayload.parse(input), page = await getPage(payload.pageId), sections = await getSections(page.id), policy = policyFor(page);
    requirePermission(policy, 'updatePage'); checkPageVersion(page, payload.expectedVersion);
    const changes = payload.changes; const fields: string[] = []; const binds: unknown[] = [];
    if (changes.title !== undefined) { fields.push('title=?'); binds.push(changes.title); }
    if (changes.seoTitle !== undefined) { fields.push('seo_title=?'); binds.push(changes.seoTitle); }
    if (changes.seoDescription !== undefined) { fields.push('seo_description=?'); binds.push(changes.seoDescription); }
    if (changes.status !== undefined) { fields.push('status=?'); binds.push(changes.status); }
    const before = snapshot(page, sections), nextVersion = page.version + 1, now = new Date().toISOString();
    const afterPage = { ...mapPage(page), ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value])), version: nextVersion, updatedAt: now };
    const after = { page: afterPage, sections, assetIds: before.assetIds };
    const result = { pageId: page.id, version: nextVersion, action: 'update_page' };
    return commitPageMutation(execution, page, payload.expectedVersion, 'update_page', before, after, namedMutations([pageUpdateStatement(page, payload.expectedVersion, fields.join(','), binds, nextVersion, now)]), result);
  }

  if (command === 'insert_page_section') {
    const payload = InsertPageSectionPayload.parse(input), page = await getPage(payload.pageId), current = await getSections(page.id), policy = policyFor(page);
    requirePermission(policy, 'insert'); checkPageVersion(page, payload.expectedVersion); validateSection(policy, payload, payload.sectionId);
    const id = payload.sectionId || `${page.id}:section:${uuid()}`;
    if (current.some((section) => section.id === id) || await env.DB.prepare('SELECT 1 FROM page_sections WHERE id=? LIMIT 1').bind(id).first()) throw pageError('PAGE_SECTION_ID_CONFLICT', 'The requested section ID already exists.');
    const position = Math.min(payload.position, current.length);
    const now = new Date().toISOString(), inserted = { id, pageId: page.id, sectionType: payload.sectionType as ModuleType, position, variant: payload.variant, props: payload.props, status: 'published' as const, version: 1, createdAt: now, updatedAt: now };
    await assertSectionAssets(inserted.sectionType, inserted.props);
    const sections = [...current.map((section) => ({ ...section })), inserted].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((section, index) => ({ ...section, position: index }));
    const before = snapshot(page, current), nextVersion = page.version + 1, after = snapshot({ ...page, version: nextVersion, updated_at: now }, sections, nextVersion), result = { pageId: page.id, sectionId: id, version: nextVersion, action: 'insert_page_section' };
    const statements: D1PreparedStatement[] = [pageUpdateStatement(page, payload.expectedVersion, '', [], nextVersion, now), ...positionStatements(page.id, sections), env.DB.prepare('INSERT INTO page_sections (id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, page.id, inserted.sectionType, position, inserted.variant, JSON.stringify(inserted.props), inserted.status, 1, now, now)];
    return commitPageMutation(execution, page, payload.expectedVersion, 'insert_page_section', before, after, namedMutations(statements), result);
  }

  if (command === 'update_page_section') {
    const payload = UpdatePageSectionPayload.parse(input), page = await getPage(payload.pageId), current = await getSections(page.id), section = sectionById(current, payload.sectionId), policy = policyFor(page);
    requirePermission(policy, 'update'); checkPageVersion(page, payload.expectedVersion); checkSectionVersion(section, payload.expectedSectionVersion); validateSection(policy, payload, section.id); await assertSectionAssets(payload.sectionType, payload.props);
    const now = new Date().toISOString(), nextVersion = page.version + 1, nextSectionVersion = section.version + 1, updated = { ...section, sectionType: payload.sectionType as ModuleType, variant: payload.variant, props: payload.props, version: nextSectionVersion, updatedAt: now }, sections = current.map((item) => item.id === section.id ? updated : item);
    const before = snapshot(page, current), after = snapshot({ ...page, version: nextVersion, updated_at: now }, sections, nextVersion), result = { pageId: page.id, sectionId: section.id, version: nextVersion, sectionVersion: nextSectionVersion, action: 'update_page_section' };
    const statements = [pageUpdateStatement(page, payload.expectedVersion, '', [], nextVersion, now), env.DB.prepare('UPDATE page_sections SET section_type=?,variant=?,props_json=?,version=?,updated_at=? WHERE id=? AND page_id=? AND version=?').bind(updated.sectionType, updated.variant, JSON.stringify(updated.props), updated.version, now, section.id, page.id, payload.expectedSectionVersion)];
    return commitPageMutation(execution, page, payload.expectedVersion, 'update_page_section', before, after, namedMutations(statements), result);
  }

  if (command === 'remove_page_section') {
    const payload = RemovePageSectionPayload.parse(input), page = await getPage(payload.pageId), current = await getSections(page.id), section = sectionById(current, payload.sectionId), policy = policyFor(page);
    requirePermission(policy, 'remove'); checkPageVersion(page, payload.expectedVersion); checkSectionVersion(section, payload.expectedSectionVersion); assertModulePolicy(policy, section.sectionType, section.id);
    const remaining = current.filter((item) => item.id !== section.id).map((item, index) => ({ ...item, position: index })), before = snapshot(page, current), now = new Date().toISOString(), nextVersion = page.version + 1, after = snapshot({ ...page, version: nextVersion, updated_at: now }, remaining, nextVersion), result = { pageId: page.id, sectionId: section.id, version: nextVersion, action: 'remove_page_section' };
    const statements: D1PreparedStatement[] = [pageUpdateStatement(page, payload.expectedVersion, '', [], nextVersion, now), ...positionStatements(page.id, remaining), env.DB.prepare('DELETE FROM page_sections WHERE id=? AND page_id=? AND version=?').bind(section.id, page.id, payload.expectedSectionVersion)];
    return commitPageMutation(execution, page, payload.expectedVersion, 'remove_page_section', before, after, namedMutations(statements), result);
  }

  if (command === 'reorder_page_sections') {
    const payload = ReorderPageSectionsPayload.parse(input), page = await getPage(payload.pageId), current = await getSections(page.id), policy = policyFor(page);
    requirePermission(policy, 'reorder'); checkPageVersion(page, payload.expectedVersion);
    if (new Set(payload.sectionIds).size !== payload.sectionIds.length) throw pageError('PAGE_REORDER_DUPLICATE_SECTION', 'Reorder payload contains duplicate section IDs.');
    const currentIds = new Set(current.map((section) => section.id));
    const unknown = payload.sectionIds.filter((id) => !currentIds.has(id));
    const missing = [...currentIds].filter((id) => !payload.sectionIds.includes(id));
    if (unknown.length || missing.length || payload.sectionIds.length !== current.length) throw pageError('PAGE_REORDER_SECTION_SET_MISMATCH', 'Reorder payload must contain the complete current section ID set.', { unknown, missing });
    const reordered = payload.sectionIds.map((id, position) => ({ ...current.find((section) => section.id === id)!, position })), before = snapshot(page, current), now = new Date().toISOString(), nextVersion = page.version + 1, after = snapshot({ ...page, version: nextVersion, updated_at: now }, reordered, nextVersion), result = { pageId: page.id, version: nextVersion, action: 'reorder_page_sections' };
    return commitPageMutation(execution, page, payload.expectedVersion, 'reorder_page_sections', before, after, namedMutations([pageUpdateStatement(page, payload.expectedVersion, '', [], nextVersion, now), ...positionStatements(page.id, reordered)]), result);
  }

  if (command === 'replace_page_section_asset') {
    const payload = ReplacePageSectionAssetPayload.parse(input), page = await getPage(payload.pageId), current = await getSections(page.id), section = sectionById(current, payload.sectionId), policy = policyFor(page);
    requirePermission(policy, 'replaceAsset'); checkPageVersion(page, payload.expectedVersion); checkSectionVersion(section, payload.expectedSectionVersion); assertModulePolicy(policy, section.sectionType, section.id);
    const slot = getModuleAssetSlot(section.sectionType, payload.assetPath);
    if (!slot) throw pageError('PAGE_ASSET_PATH_INVALID', `Asset path is not registered for ${section.sectionType}: ${payload.assetPath}`);
    let assetId = payload.assetId;
    const assetReference = payload.reference;
    let intakeStatements: D1PreparedStatement[] = [];
    if (assetReference) {
      if (slot.role !== assetReference.intendedRole) throw pageError('PAGE_ASSET_ROLE_MISMATCH', 'Asset reference role does not match the registered Page module slot.');
      if (!options.resolveAssetReference) throw pageError('PAGE_ASSET_INTAKE_UNAVAILABLE', 'Asset provider intake is not available for this runtime.');
      const resolved = await options.resolveAssetReference(assetReference, slot.role);
      assetId = resolved.result.assetId;
      // The intake's D1 registration travels into this command's own fenced
      // batch; intake never writes on its own.
      intakeStatements = resolved.statements;
    }
    if (!assetId) throw pageError('PAGE_ASSET_REQUIRED', 'A canonical Asset ID or provider reference is required.');
    // A canonical id names an asset that must already exist. A prepared
    // reference is registered by this command's own fenced batch, so querying
    // for it now would look for a row this command has not written yet -- which
    // is what made every first-time provider-backed section replacement fail.
    // Its validity comes from the preparation and from that registration.
    if (!assetReference) {
      const asset = await env.DB.prepare("SELECT id FROM assets WHERE id=? AND validation_status='validated' AND r2_key IS NOT NULL AND bytes > 0 LIMIT 1").bind(assetId).first<{ id: string }>();
      if (!asset) throw pageError('PAGE_ASSET_UNUSABLE', 'The requested Asset is missing or unavailable.');
    }
    const props = cloneWithAssetPath(section.props, payload.assetPath, assetId); validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props }, section.id);
    // Only the asset this batch is about to register is exempt; every other
    // slot, and any reusable pattern the section pulls in, is still validated.
    await assertSectionAssets(section.sectionType, props, assetReference ? new Set([assetId]) : new Set());
    const now = new Date().toISOString(), nextVersion = page.version + 1, nextSectionVersion = section.version + 1, updated = { ...section, props, version: nextSectionVersion, updatedAt: now }, sections = current.map((item) => item.id === section.id ? updated : item), before = snapshot(page, current), after = snapshot({ ...page, version: nextVersion, updated_at: now }, sections, nextVersion), result = { pageId: page.id, sectionId: section.id, assetId, version: nextVersion, sectionVersion: nextSectionVersion, action: 'replace_page_section_asset' };
    const statements = [...intakeStatements, pageUpdateStatement(page, payload.expectedVersion, '', [], nextVersion, now), env.DB.prepare('UPDATE page_sections SET props_json=?,version=?,updated_at=? WHERE id=? AND page_id=? AND version=?').bind(JSON.stringify(props), nextSectionVersion, now, section.id, page.id, payload.expectedSectionVersion)];
    return await commitPageMutation(execution, page, payload.expectedVersion, 'replace_page_section_asset', before, after, namedMutations(statements), result);
  }

  if (command === 'rollback_page') {
    const payload = RollbackPagePayload.parse(input), page = await getPage(payload.pageId), current = await getSections(page.id), policy = policyFor(page);
    requirePermission(policy, 'rollback'); checkPageVersion(page, payload.expectedVersion);
    const revision = await env.DB.prepare('SELECT id,after_json FROM content_revisions WHERE id=? AND content_type=? AND content_id=? LIMIT 1').bind(payload.revisionId, 'page', page.id).first<{ id: string; after_json: string | null }>();
    if (!revision?.after_json) throw pageError('PAGE_REVISION_NOT_FOUND', 'The requested page revision was not found.');
    let raw: unknown; try { raw = JSON.parse(revision.after_json); } catch { throw pageError('PAGE_REVISION_INVALID', 'The requested page revision is not valid JSON.'); }
    const restored = await validateSnapshot(raw, page.id);
    for (const section of restored.sections) validateSection(policy, { sectionType: section.sectionType, variant: section.variant, props: section.props }, section.id);
    const now = new Date().toISOString(), nextVersion = page.version + 1, restoredPage = { ...restored.page, version: nextVersion, updatedAt: now }, restoredSections = restored.sections.map((section, position) => ({ ...section, position, updatedAt: now })), before = snapshot(page, current), after = { page: restoredPage, sections: restoredSections, assetIds: collectSectionAssetIds(restoredSections) }, result = { pageId: page.id, version: nextVersion, revisionId: payload.revisionId, action: 'rollback_page' };
    const statements: D1PreparedStatement[] = [pageUpdateStatement(page, payload.expectedVersion, 'title=?,page_type=?,template_profile=?,status=?,seo_title=?,seo_description=?', [restoredPage.title, restoredPage.pageType, restoredPage.templateProfile, restoredPage.status, restoredPage.seoTitle, restoredPage.seoDescription], nextVersion, now), env.DB.prepare('DELETE FROM page_sections WHERE page_id=?').bind(page.id)];
    for (const section of restoredSections) statements.push(env.DB.prepare('INSERT INTO page_sections (id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(section.id, page.id, section.sectionType, section.position, section.variant, JSON.stringify(section.props), section.status, section.version, section.createdAt, section.updatedAt));
    return commitPageMutation(execution, page, payload.expectedVersion, 'rollback_page', before, after, namedMutations(statements), result);
  }

  throw new CommandError('FATAL_SYSTEM_ERROR', 'PAGE_COMMAND_NOT_IMPLEMENTED', `Page command not implemented: ${command}`);
}
