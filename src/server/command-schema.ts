import { z } from 'zod';
import { ContentAST } from './core/content-ast';
import { AssetIntakeDescriptor } from './core/assets';
import { WordPressAssetReference } from './adapters/assets/wordpress';
import { MODULE_TYPES, PageStatus, PageType } from './page-composition/schemas';

export const CommandEnvelope = z.object({
  schemaVersion: z.literal(1),
  commandId: z.string().min(8),
  command: z.enum(['create_news','create_taxonomy_term','create_timed_content','create_asset','import_wordpress_asset','update_content','archive_content','rollback_content','schedule_content','attach_asset','replace_asset','update_seo','create_product','update_product','publish_product','archive_product','replace_product_asset','attach_product_asset','remove_product_asset','reorder_product_assets','rollback_product','create_page','update_page','insert_page_section','update_page_section','remove_page_section','reorder_page_sections','replace_page_section_asset','rollback_page','insert_page_section_item','update_page_section_item','remove_page_section_item','reorder_page_section_items','replace_page_section_item_asset']),
  issuedAt: z.string().datetime(),
  context: z.object({
    ruleVersion:z.string(),
    targetSite:z.string().optional(),
    requiresAssetIntake: z.boolean().optional(),
    preflight: z.object({ commandDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), contractVersion: z.string().min(1).max(200) }).strict().optional()
  }).strict(),
  payload: z.unknown()
}).strict();

const ContentTarget = { contentType: z.enum(['news','article']), contentId: z.string().min(1).max(200), expectedVersion: z.number().int().positive() };
const ChangeSet = z.object({
  title: z.string().min(1).max(80).optional(),
  excerpt: z.string().max(160).nullable().optional(),
  blocks: ContentAST.optional()
}).strict();

export const UpdateContentPayload = z.object({ ...ContentTarget, changes: ChangeSet }).strict().refine((value) => Object.keys(value.changes).length > 0, 'At least one content field must be changed');
export const ArchiveContentPayload = z.object(ContentTarget).strict();
export const RollbackContentPayload = z.object({ ...ContentTarget, revisionId: z.string().min(1).max(200) }).strict();
export const ScheduleContentPayload = z.object({ ...ContentTarget, startsAt: z.string().datetime(), endsAt: z.string().datetime().nullable().optional() }).strict();
export const UpdateSeoPayload = z.object({ ...ContentTarget, seoTitle: z.string().max(60).nullable(), seoDescription: z.string().max(160).nullable() }).strict();

export const AssetReference = z.object({
  provider: z.enum(['google_drive','generated']),
  providerAssetId: z.string().min(3).max(512),
  intendedRole: z.enum(['hero','thumbnail','ogp','inline']),
  alt: z.string().max(500).optional().default(''),
  metadata: z.record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).optional().default({}),
  expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();
const AssetTarget = { contentType: z.enum(['news','article']), contentId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), role: z.enum(['hero','thumbnail','ogp','inline']), position: z.number().int().nonnegative().default(0) };
export const AttachAssetPayload = z.object({ ...AssetTarget, assetId: z.string().min(1).max(200) }).strict();
export const ReplaceAssetPayload = z.object({ ...AssetTarget, assetId: z.string().min(1).max(200).optional(), reference: AssetReference.optional() }).strict().refine((value) => Boolean(value.assetId) !== Boolean(value.reference), 'Provide exactly one of assetId or reference');
export type ReplaceAssetCommand = z.infer<typeof ReplaceAssetPayload>;

export const CreateTaxonomyTermPayload = z.object({
  taxonomy: z.enum(['category','tag']),
  name: z.string().min(1).max(200),
  slug: z.string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  parentTermId: z.string().min(1).max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  seoTitle: z.string().max(200).nullable().optional(),
  seoDescription: z.string().max(500).nullable().optional()
}).strict();

/**
 * `content_term_links` is keyed by (content_type, content_id, term_id) and the
 * create path inserts one row per submitted id with no conflict handling, so a
 * repeated id fails the write with a primary-key violation instead of being
 * ignored. Duplicates are rejected at the schema boundary, where the operator
 * still gets a correctable error.
 *
 * `.meta` publishes the same constraint into the generated JSON Schema, so the
 * runtime rule and the published contract cannot drift apart.
 */
const TaxonomyTermIds = z
  .array(z.string().min(1))
  .refine((ids) => new Set(ids).size === ids.length, 'Taxonomy term ids must be unique')
  .meta({ uniqueItems: true })
  .default([]);

export const CreateNewsPayload = z.object({
  title: z.string().min(1).max(80),
  slug: z.string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  excerpt: z.string().max(160).nullable().optional(),
  blocks: ContentAST,
  contentType: z.enum(['news','article']).default('news'),
  templateProfile: z.string().max(80).default('news-default'),
  categoryTermIds: TaxonomyTermIds,
  tagTermIds: TaxonomyTermIds,
  publishedAt: z.string().datetime().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  seoTitle: z.string().max(60).nullable().optional(),
  seoDescription: z.string().max(160).nullable().optional(),
  expectedVersion: z.number().int().positive().nullable().optional()
}).strict();

export const CreateTimedContentPayload = z.object({
  type: z.enum(['banner','notice','emergency','cta','popup','seasonal']),
  placement: z.enum(['global_top','header_after','top_hero_after','top_news_before','top_news_after','content_bottom','article_bottom','footer_before','recruit_top']),
  title: z.string().max(60).nullable().optional(),
  body: z.string().max(180).nullable().optional(),
  linkLabel: z.string().max(40).nullable().optional(),
  linkUrl: z.string().max(2048).nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  priority: z.union([z.literal(10), z.literal(30), z.literal(50), z.literal(100)]).default(10),
  dismissible: z.boolean().default(false)
}).strict();

export const CreateAssetPayload = z.object({
  descriptor: AssetIntakeDescriptor,
  transfer: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Asset transfer must be an in-memory Uint8Array')
}).strict();

export const ImportWordPressAssetPayload = z.object({
  reference: WordPressAssetReference
}).strict();

const ProductTarget = { productId: z.string().min(1).max(200), expectedVersion: z.number().int().positive() };
const ProductChanges = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  category: z.string().max(160).optional(),
  priceAmount: z.number().nonnegative().nullable().optional(),
  priceCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  priceDisplay: z.string().max(160).nullable().optional(),
  minimumOrderQuantity: z.string().max(160).nullable().optional(),
  seoTitleOverride: z.string().max(160).nullable().optional(),
  seoDescriptionOverride: z.string().max(320).nullable().optional(),
  ogImageOverride: z.string().regex(/^\/(?!\/)[^\s<>{}]*$/).nullable().optional(),
  thumbnailOverride: z.string().regex(/^\/(?!\/)[^\s<>{}]*$/).nullable().optional(),
  breadcrumbLabelOverride: z.string().max(160).nullable().optional(),
  cardExcerptOverride: z.string().max(1000).nullable().optional()
}).strict();
export const CreateProductPayload = z.object({
  expectedVersion: z.literal(0), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/), title: z.string().min(1).max(200), description: z.string().max(5000).default(''), category: z.string().max(160).default(''), priceAmount: z.number().nonnegative().nullable().default(null), priceCurrency: z.string().regex(/^[A-Z]{3}$/).default('JPY'), priceDisplay: z.string().max(160).nullable().default(null), minimumOrderQuantity: z.string().max(160).nullable().default(null), primaryAssetId: z.string().regex(/^asset_[a-f0-9]{64}_(original|large|medium|thumbnail|ogp)$/).nullable().default(null), status: z.enum(['draft','published','archived','scheduled']).default('draft'), publishedAt: z.string().datetime().nullable().default(null), seoTitleOverride: z.string().max(160).nullable().default(null), seoDescriptionOverride: z.string().max(320).nullable().default(null), ogImageOverride: z.string().regex(/^\/(?!\/)[^\s<>{}]*$/).nullable().default(null), thumbnailOverride: z.string().regex(/^\/(?!\/)[^\s<>{}]*$/).nullable().default(null), breadcrumbLabelOverride: z.string().max(160).nullable().default(null), cardExcerptOverride: z.string().max(1000).nullable().default(null)
}).strict();
export const UpdateProductPayload = z.object({ ...ProductTarget, changes: ProductChanges }).strict().refine((value) => Object.keys(value.changes).length > 0, 'At least one product field must be changed');
export const PublishProductPayload = z.object({ ...ProductTarget, publishedAt: z.string().datetime().nullable().optional() }).strict();
export const ArchiveProductPayload = z.object(ProductTarget).strict();
export const RollbackProductPayload = z.object({ ...ProductTarget, revisionId: z.string().min(1).max(200) }).strict();
const ProductAssetTarget = { ...ProductTarget, assetId: z.string().regex(/^asset_[a-f0-9]{64}_(original|large|medium|thumbnail|ogp)$/).optional(), reference: AssetReference.optional(), role: z.enum(['primary','gallery']), position: z.number().int().nonnegative().default(0) };
export const AttachProductAssetPayload = z.object(ProductAssetTarget).strict().refine((value) => Boolean(value.assetId) && !value.reference, 'Attach requires a canonical assetId');
export const ReplaceProductAssetPayload = z.object(ProductAssetTarget).strict().refine((value) => Boolean(value.assetId) !== Boolean(value.reference), 'Provide exactly one of assetId or reference');
export type ReplaceProductAssetCommand = z.infer<typeof ReplaceProductAssetPayload>;
export const RemoveProductAssetPayload = z.object({ ...ProductTarget, role: z.enum(['primary','gallery']), position: z.number().int().nonnegative().default(0) }).strict();
export const ReorderProductAssetsPayload = z.object({ ...ProductTarget, role: z.enum(['primary','gallery']), assetIds: z.array(z.string().regex(/^asset_[a-f0-9]{64}_(original|large|medium|thumbnail|ogp)$/)).min(1).max(50) }).strict();

const PageId = z.string().min(1).max(200);
const SectionId = z.string().min(1).max(200);
const ModulePayload = z.object({
  sectionType: z.enum(MODULE_TYPES),
  variant: z.string().min(1).max(40),
  props: z.unknown()
}).strict();
const PageSectionSeed = ModulePayload.extend({ id: SectionId.optional(), position: z.number().int().nonnegative().optional() }).strict();

export const CreatePagePayload = z.object({
  expectedVersion: z.literal(0),
  slug: z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,199}$/),
  title: z.string().min(1).max(200),
  pageType: PageType,
  templateProfile: z.string().min(1).max(80),
  status: PageStatus.default('draft'),
  seoTitle: z.string().max(160).nullable().default(null),
  seoDescription: z.string().max(320).nullable().default(null),
  sections: z.array(PageSectionSeed).max(50).default([])
}).strict();

const PageTarget = { pageId: PageId, expectedVersion: z.number().int().positive() };
const PageChanges = z.object({
  title: z.string().min(1).max(200).optional(),
  seoTitle: z.string().max(160).nullable().optional(),
  seoDescription: z.string().max(320).nullable().optional(),
  status: PageStatus.optional()
}).strict();
export const UpdatePagePayload = z.object({ ...PageTarget, changes: PageChanges }).strict().refine((value) => Object.keys(value.changes).length > 0, 'At least one page field must be changed');

export const InsertPageSectionPayload = z.object({
  ...PageTarget,
  sectionId: SectionId.optional(),
  position: z.number().int().nonnegative(),
  ...ModulePayload.shape
}).strict();

export const UpdatePageSectionPayload = z.object({
  ...PageTarget,
  sectionId: SectionId,
  expectedSectionVersion: z.number().int().positive(),
  ...ModulePayload.shape
}).strict();

export const RemovePageSectionPayload = z.object({
  ...PageTarget,
  sectionId: SectionId,
  expectedSectionVersion: z.number().int().positive()
}).strict();

export const ReorderPageSectionsPayload = z.object({
  ...PageTarget,
  sectionIds: z.array(SectionId).min(1).max(50)
}).strict();

export const ReplacePageSectionAssetPayload = z.object({
  ...PageTarget,
  sectionId: SectionId,
  expectedSectionVersion: z.number().int().positive(),
  assetPath: z.string().regex(/^(assetId|items\[\d+\]\.assetId)$/),
  assetId: z.string().regex(/^asset_[a-f0-9]{64}_(original|large|medium|thumbnail|ogp)$/).optional(),
  reference: AssetReference.optional()
}).strict().refine((value) => Boolean(value.assetId) !== Boolean(value.reference), 'Provide exactly one of assetId or reference');

export const RollbackPagePayload = z.object({
  ...PageTarget,
  revisionId: z.string().min(1).max(200)
}).strict();

const PageItemTarget = { pageId: PageId, sectionId: SectionId, expectedVersion: z.number().int().positive(), expectedSectionVersion: z.number().int().positive() };
const ItemId = z.string().min(1).max(200);
const ItemPayload = z.object({ itemId: ItemId, item: z.unknown() }).strict();
export const InsertPageSectionItemPayload = z.object({ ...PageItemTarget, position: z.number().int().nonnegative(), item: z.unknown() }).strict();
export const UpdatePageSectionItemPayload = z.object({ ...PageItemTarget, ...ItemPayload.shape }).strict();
export const RemovePageSectionItemPayload = z.object({ ...PageItemTarget, itemId: ItemId }).strict();
export const ReorderPageSectionItemsPayload = z.object({ ...PageItemTarget, itemIds: z.array(ItemId).min(1).max(50) }).strict();
export const ReplacePageSectionItemAssetPayload = z.object({ ...PageItemTarget, itemId: ItemId, assetId: z.string().regex(/^asset_[a-f0-9]{64}_(original|large|medium|thumbnail|ogp)$/) }).strict();

/** The payload schema map is the single source for machine-readable command contracts. */
export const COMMAND_PAYLOAD_SCHEMAS = {
  create_news: CreateNewsPayload,
  create_taxonomy_term: CreateTaxonomyTermPayload,
  create_timed_content: CreateTimedContentPayload,
  create_asset: CreateAssetPayload,
  import_wordpress_asset: ImportWordPressAssetPayload,
  update_content: UpdateContentPayload,
  archive_content: ArchiveContentPayload,
  rollback_content: RollbackContentPayload,
  schedule_content: ScheduleContentPayload,
  attach_asset: AttachAssetPayload,
  replace_asset: ReplaceAssetPayload,
  update_seo: UpdateSeoPayload,
  create_product: CreateProductPayload,
  update_product: UpdateProductPayload,
  publish_product: PublishProductPayload,
  archive_product: ArchiveProductPayload,
  replace_product_asset: ReplaceProductAssetPayload,
  attach_product_asset: AttachProductAssetPayload,
  remove_product_asset: RemoveProductAssetPayload,
  reorder_product_assets: ReorderProductAssetsPayload,
  rollback_product: RollbackProductPayload,
  create_page: CreatePagePayload,
  update_page: UpdatePagePayload,
  insert_page_section: InsertPageSectionPayload,
  update_page_section: UpdatePageSectionPayload,
  remove_page_section: RemovePageSectionPayload,
  reorder_page_sections: ReorderPageSectionsPayload,
  replace_page_section_asset: ReplacePageSectionAssetPayload,
  rollback_page: RollbackPagePayload,
  insert_page_section_item: InsertPageSectionItemPayload,
  update_page_section_item: UpdatePageSectionItemPayload,
  remove_page_section_item: RemovePageSectionItemPayload,
  reorder_page_section_items: ReorderPageSectionItemsPayload,
  replace_page_section_item_asset: ReplacePageSectionItemAssetPayload
} as const;
