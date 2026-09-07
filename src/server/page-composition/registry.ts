import { CommandError } from '../core/errors';
import { MODULE_SCHEMAS, MODULE_TYPES, type ModuleProps, type ModuleType } from './schemas';

export const MODULE_REGISTRY = {
  hero: { type: 'hero', allowedVariants: ['standard', 'corporate', 'minimal'], assetFields: { assetId: 'hero' }, allowsReusable: false },
  richText: { type: 'richText', allowedVariants: ['standard', 'narrow'], assetFields: {}, allowsReusable: true },
  mediaText: { type: 'mediaText', allowedVariants: ['image-left', 'image-right', 'image-top'], assetFields: { assetId: 'hero' }, allowsReusable: false },
  cardGrid: { type: 'cardGrid', allowedVariants: ['service', 'feature', 'team', 'product'], assetFields: { 'items[].assetId': 'thumbnail' }, allowsReusable: false },
  stats: { type: 'stats', allowedVariants: ['standard', 'compact'], assetFields: {}, allowsReusable: false },
  faq: { type: 'faq', allowedVariants: ['standard', 'compact'], assetFields: {}, allowsReusable: false },
  timeline: { type: 'timeline', allowedVariants: ['standard', 'compact'], assetFields: {}, allowsReusable: false },
  table: { type: 'table', allowedVariants: ['standard', 'compact'], assetFields: {}, allowsReusable: false },
  logoCloud: { type: 'logoCloud', allowedVariants: ['grid', 'compact'], assetFields: { 'items[].assetId': 'thumbnail' }, allowsReusable: false },
  contentList: { type: 'contentList', allowedVariants: ['news', 'article', 'product'], assetFields: { 'items[].assetId': 'thumbnail' }, allowsReusable: false },
  cta: { type: 'cta', allowedVariants: ['primary', 'secondary', 'banner'], assetFields: {}, allowsReusable: false },
  reusable: { type: 'reusable', allowedVariants: ['default', 'compact'], assetFields: {}, allowsReusable: true }
} as const satisfies Record<ModuleType, { type: ModuleType; allowedVariants: readonly string[]; assetFields: Record<string, string>; allowsReusable: boolean }>;

export type ModuleRegistryEntry = (typeof MODULE_REGISTRY)[ModuleType];

export function getModuleRegistryEntry(type: string): ModuleRegistryEntry {
  if (!MODULE_TYPES.includes(type as ModuleType)) throw new CommandError('USER_CORRECTABLE', 'UNKNOWN_PAGE_MODULE', `Page module is not registered: ${type}`);
  return MODULE_REGISTRY[type as ModuleType];
}

export function validatePageModule(input: { sectionType: string; variant: string; props: unknown }): ModuleProps {
  const entry = getModuleRegistryEntry(input.sectionType);
  if (!(entry.allowedVariants as readonly string[]).includes(input.variant)) throw new CommandError('USER_CORRECTABLE', 'INVALID_PAGE_MODULE_VARIANT', `Variant is not registered for ${input.sectionType}: ${input.variant}`);
  const schema = MODULE_SCHEMAS[input.sectionType as ModuleType];
  const result = schema.safeParse(input.props);
  if (!result.success) throw new CommandError('USER_CORRECTABLE', 'INVALID_PAGE_MODULE_PROPS', `Props failed strict schema validation for ${input.sectionType}.`, false, { issues: result.error.issues });
  return result.data as ModuleProps;
}

export type PageAssetReference = { assetId: string; assetPath: string; role: string };

/** Resolve a requested path against the registry, including an empty slot. */
export function getModuleAssetSlot(type: string, assetPath: string): { assetPath: string; role: string } | null {
  const entry = getModuleRegistryEntry(type);
  const normalizedPath = /^items\[\d+\]\.assetId$/.test(assetPath) ? 'items[].assetId' : assetPath;
  const role = (entry.assetFields as Record<string, string>)[normalizedPath];
  return role ? { assetPath: normalizedPath, role } : null;
}

/** Extract only asset slots declared by the trusted registry. */
export function extractModuleAssetReferences(input: { sectionType: string; props: unknown }): PageAssetReference[] {
  const entry = getModuleRegistryEntry(input.sectionType);
  const props = input.props && typeof input.props === 'object' && !Array.isArray(input.props)
    ? input.props as Record<string, unknown>
    : {};
  const references: PageAssetReference[] = [];
  for (const [path, role] of Object.entries(entry.assetFields)) {
    if (path === 'assetId' && typeof props.assetId === 'string') references.push({ assetId: props.assetId, assetPath: path, role });
    if (path === 'items[].assetId' && Array.isArray(props.items)) {
      for (const [index, item] of props.items.entries()) {
        if (item && typeof item === 'object' && typeof (item as { assetId?: unknown }).assetId === 'string') {
          references.push({ assetId: (item as { assetId: string }).assetId, assetPath: `items[${index}].assetId`, role });
        }
      }
    }
  }
  return references;
}

export function listPageModuleTypes() { return [...MODULE_TYPES]; }
