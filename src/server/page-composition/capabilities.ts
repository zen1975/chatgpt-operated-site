import capabilityConfig from '../../../config/page-capabilities.json';
import { z } from 'zod';
import { MODULE_TYPES } from './schemas';

const CapabilityPermissions = z.object({
  updatePage: z.boolean(),
  insert: z.boolean(),
  update: z.boolean(),
  remove: z.boolean(),
  reorder: z.boolean(),
  replaceAsset: z.boolean(),
  rollback: z.boolean()
}).strict();

export const PageCapabilityPolicy = z.object({
  allowedSectionTypes: z.array(z.enum(MODULE_TYPES)).min(1),
  permissions: CapabilityPermissions,
  lockedSectionIds: z.array(z.string().min(1).max(200)).default([])
}).strict();

export const PageCapabilities = z.object({
  schemaVersion: z.literal(1),
  pages: z.record(z.string().min(1).max(100), PageCapabilityPolicy)
}).strict();

export type PageCapabilitiesConfig = z.infer<typeof PageCapabilities>;
export type PageCapability = z.infer<typeof PageCapabilityPolicy>;

export function loadPageCapabilities(input: unknown = capabilityConfig): PageCapabilitiesConfig {
  return PageCapabilities.parse(input);
}

export function resolvePageCapability(pageKey: string, input: unknown = capabilityConfig): PageCapability {
  const policy = loadPageCapabilities(input).pages[pageKey];
  if (!policy) throw new Error(`PAGE_CAPABILITY_POLICY_MISSING:${pageKey}`);
  return policy;
}

export function assertSectionAllowed(policy: PageCapability, sectionType: string, sectionId?: string) {
  if (!policy.allowedSectionTypes.includes(sectionType as (typeof MODULE_TYPES)[number])) throw new Error(`PAGE_SECTION_TYPE_NOT_ALLOWED:${sectionType}`);
  if (sectionId && policy.lockedSectionIds.includes(sectionId)) throw new Error(`PAGE_SECTION_LOCKED:${sectionId}`);
}
