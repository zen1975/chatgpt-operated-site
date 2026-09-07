import { z } from 'zod';
import { ContentAST } from '../core/content-ast';

export const PageType = z.enum(['standard', 'landing', 'company', 'service', 'contact', 'custom']);
export const PageStatus = z.enum(['draft', 'published', 'archived']);
export const PageSectionStatus = z.enum(['draft', 'published', 'archived']);

export const AssetId = z.string().regex(/^asset_[a-f0-9]{64}_(original|large|medium|thumbnail|ogp)$/, 'Asset ID must be a canonical Asset Engine ID');
export const PageHref = z.string().regex(/^\/(?!\/)[^\s<>{}]*$/, 'Page links must be same-origin paths');
export const Cta = z.object({ label: z.string().min(1).max(80), href: PageHref }).strict();
export const TextItem = z.object({ id: z.string().min(1).max(200).optional(), title: z.string().min(1).max(160), body: z.string().max(2000).optional() }).strict();

const HeroProps = z.object({
  eyebrow: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  lead: z.string().max(2000).optional(),
  assetId: AssetId.optional(),
  primaryCta: Cta.optional(),
  secondaryCta: Cta.optional()
}).strict();

const RichTextProps = z.object({
  heading: z.string().max(160).optional(),
  blocks: ContentAST.max(50)
}).strict();

const MediaTextProps = z.object({
  eyebrow: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  body: z.string().max(3000),
  assetId: AssetId,
  alt: z.string().max(500).default(''),
  cta: Cta.optional()
}).strict();

const CardItem = z.object({
  id: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(160),
  body: z.string().max(2000).optional(),
  eyebrow: z.string().max(80).optional(),
  assetId: AssetId.optional(),
  href: PageHref.optional()
}).strict();

const CardGridProps = z.object({
  heading: z.string().max(160).optional(),
  items: z.array(CardItem).min(1).max(12)
}).strict();

const StatsProps = z.object({
  heading: z.string().max(160).optional(),
  items: z.array(z.object({ id: z.string().min(1).max(200).optional(), label: z.string().min(1).max(80), value: z.string().min(1).max(80), body: z.string().max(500).optional() }).strict()).min(1).max(8)
}).strict();

const FaqProps = z.object({
  heading: z.string().max(160).optional(),
  items: z.array(z.object({ id: z.string().min(1).max(200).optional(), question: z.string().min(1).max(240), answer: z.string().min(1).max(3000) }).strict()).min(1).max(20)
}).strict();

const TimelineProps = z.object({
  heading: z.string().max(160).optional(),
  items: z.array(z.object({ id: z.string().min(1).max(200).optional(), date: z.string().min(1).max(80), title: z.string().min(1).max(160), body: z.string().max(2000).optional() }).strict()).min(1).max(20)
}).strict();

const TableProps = z.object({
  heading: z.string().max(160).optional(),
  headers: z.array(z.string().min(1).max(160)).min(1).max(12),
  rows: z.array(z.union([
    z.object({ id: z.string().min(1).max(200), cells: z.array(z.string().max(500)).max(12) }).strict(),
    z.array(z.string().max(500)).max(12)
  ])).max(100)
}).strict();

const LogoCloudProps = z.object({
  heading: z.string().max(160).optional(),
  items: z.array(z.object({ id: z.string().min(1).max(200).optional(), name: z.string().min(1).max(160), assetId: AssetId, href: PageHref.optional() }).strict()).min(1).max(30)
}).strict();

const ContentListProps = z.object({
  heading: z.string().max(160).optional(),
  items: z.array(z.object({ id: z.string().min(1).max(200).optional(), title: z.string().min(1).max(160), excerpt: z.string().max(1000).optional(), meta: z.string().max(160).optional(), assetId: AssetId.optional(), href: PageHref }).strict()).min(1).max(20)
}).strict();

const CtaProps = z.object({
  eyebrow: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  body: z.string().max(2000).optional(),
  primaryCta: Cta,
  secondaryCta: Cta.optional()
}).strict();

const ReusableProps = z.object({ ref: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/) }).strict();

export const MODULE_TYPES = ['hero', 'richText', 'mediaText', 'cardGrid', 'stats', 'faq', 'timeline', 'table', 'logoCloud', 'contentList', 'cta', 'reusable'] as const;
export type ModuleType = typeof MODULE_TYPES[number];

export const MODULE_SCHEMAS = {
  hero: HeroProps,
  richText: RichTextProps,
  mediaText: MediaTextProps,
  cardGrid: CardGridProps,
  stats: StatsProps,
  faq: FaqProps,
  timeline: TimelineProps,
  table: TableProps,
  logoCloud: LogoCloudProps,
  contentList: ContentListProps,
  cta: CtaProps,
  reusable: ReusableProps
} as const;

export type ModuleProps = { [K in ModuleType]: z.infer<(typeof MODULE_SCHEMAS)[K]> }[ModuleType];

export const PageRecord = z.object({
  id: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,199}$/),
  title: z.string().min(1).max(200),
  pageType: PageType,
  templateProfile: z.string().min(1).max(80),
  status: PageStatus,
  seoTitle: z.string().max(160).nullable(),
  seoDescription: z.string().max(320).nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const PageSectionRecord = z.object({
  id: z.string().min(1).max(200),
  pageId: z.string().min(1).max(200),
  sectionType: z.enum(MODULE_TYPES),
  position: z.number().int().nonnegative(),
  variant: z.string().min(1).max(40),
  props: z.unknown(),
  status: PageSectionStatus,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
