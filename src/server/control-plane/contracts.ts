import { MODULE_REGISTRY, listPageModuleTypes } from '../page-composition/registry';
import { MODULE_SCHEMAS, type ModuleType } from '../page-composition/schemas';
import { loadPageCapabilities } from '../page-composition/capabilities';
import { COMMAND_PAYLOAD_SCHEMAS } from '../command-schema';

type AnySchema = { _def?: Record<string, any> };

function schemaType(schema: AnySchema): string {
  const def = schema?._def || {};
  return String(def.typeName || def.type || 'unknown').replace(/^Zod/, '').toLowerCase();
}

function unwrap(schema: AnySchema): { schema: AnySchema; optional: boolean; nullable: boolean; defaultValue?: unknown } {
  let current = schema;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;
  for (;;) {
    const type = schemaType(current);
    const def = current._def || {};
    if (type === 'optional' || type === 'default' || type === 'nullable' || type === 'catch') {
      if (type === 'optional' || type === 'default' || type === 'catch') optional = true;
      if (type === 'nullable') nullable = true;
      if (type === 'default' && typeof def.defaultValue === 'function') defaultValue = def.defaultValue();
      current = def.innerType || def.type || current;
      continue;
    }
    return { schema: current, optional, nullable, ...(defaultValue === undefined ? {} : { defaultValue }) };
  }
}

function objectShape(schema: AnySchema): Record<string, AnySchema> {
  const shape = schema?._def?.shape;
  return typeof shape === 'function' ? shape() : (shape || {});
}

/** Project Zod contracts into a stable, intentionally small public DTO. */
export function projectSchema(input: AnySchema): Record<string, unknown> {
  const unwrapped = unwrap(input);
  const schema = unwrapped.schema;
  const def = schema._def || {};
  const type = schemaType(schema);
  const result: Record<string, unknown> = { type };
  if (unwrapped.nullable) result.nullable = true;
  if (unwrapped.defaultValue !== undefined) result.default = unwrapped.defaultValue;
  if (type === 'object') {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(objectShape(schema)).sort()) {
      const child = unwrap(objectShape(schema)[key]);
      properties[key] = projectSchema(objectShape(schema)[key]);
      if (!child.optional) required.push(key);
    }
    result.properties = properties;
    result.required = required;
    result.additionalProperties = false;
  } else if (type === 'array') {
    result.items = projectSchema(def.element || def.type);
  } else if (type === 'enum') {
    result.enum = Array.isArray(def.values) ? [...def.values].sort() : Object.values(def.entries || {}).sort();
  } else if (type === 'literal') {
    result.const = def.value;
  } else if (type === 'union' || type === 'discriminatedunion') {
    const options = def.options instanceof Map ? [...def.options.values()] : (def.options || []);
    result.anyOf = options.map((option: AnySchema) => projectSchema(option));
  } else if (type === 'record') {
    result.additionalProperties = projectSchema(def.valueType || def.value);
  } else if (type === 'string') {
    for (const check of def.checks || []) {
      if (check.kind === 'min' || check.check === 'min_length') result.minLength = check.value ?? check.minimum;
      if (check.kind === 'max' || check.check === 'max_length') result.maxLength = check.value ?? check.maximum;
      if (check.kind === 'regex' && check.regex?.source) result.pattern = check.regex.source;
    }
  } else if (type === 'number' || type === 'bigint') {
    for (const check of def.checks || []) {
      if (check.kind === 'min' || check.check === 'greater_than') result.minimum = check.value ?? check.minimum;
      if (check.kind === 'max' || check.check === 'less_than') result.maximum = check.value ?? check.maximum;
    }
  }
  return result;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    first = Math.imul(first ^ value.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ value.charCodeAt(index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function moduleContract(type: ModuleType) {
  const entry = MODULE_REGISTRY[type];
  return {
    sectionType: type,
    allowedVariants: [...entry.allowedVariants].sort(),
    assetFields: Object.fromEntries(Object.entries(entry.assetFields).sort()),
    allowsReusable: entry.allowsReusable,
    props: projectSchema(MODULE_SCHEMAS[type])
  };
}

export function allModuleContracts() {
  return listPageModuleTypes().sort().map((type) => moduleContract(type as ModuleType));
}

export function commandContract(command: string) {
  const schema = COMMAND_PAYLOAD_SCHEMAS[command as keyof typeof COMMAND_PAYLOAD_SCHEMAS];
  if (!schema) return null;
  return {
    command,
    schemaVersion: 1,
    payload: projectSchema(schema as unknown as AnySchema),
    versionRequirements: {
      expectedVersion: command.startsWith('create_') ? 'zero-or-absent' : 'required',
      expectedSectionVersion: command.includes('page_section') && !command.includes('reorder_page_sections') ? 'required-when-targeting-section' : 'not-applicable'
    }
  };
}

function commandTargetDomain(command: string, contract: ReturnType<typeof commandContract>) {
  const properties = contract?.payload && typeof contract.payload === 'object' && 'properties' in contract.payload
    ? Object.keys((contract.payload as { properties: Record<string, unknown> }).properties) : [];
  if (properties.includes('pageId') || command.includes('_page')) return 'page';
  if (properties.includes('productId') || command.includes('_product')) return 'product';
  if (properties.includes('contentId') || command.includes('_content')) return 'content';
  if (properties.includes('descriptor') || command.includes('_asset')) return 'asset';
  const suffix = command.slice(command.indexOf('_') + 1);
  return suffix.split('_')[0] || 'unknown';
}

export function commandCatalog() {
  return Object.keys(COMMAND_PAYLOAD_SCHEMAS).sort().map((command) => {
    const contract = commandContract(command);
    return { command, payloadContract: Boolean(contract), targetDomain: commandTargetDomain(command, contract) };
  });
}

export function pageCapabilityContract(pageId: string, pageVersion: number, pageKey: string) {
  const policy = loadPageCapabilities().pages[pageKey];
  if (!policy) return null;
  return { pageId, pageVersion, pageKey, allowedSectionTypes: [...policy.allowedSectionTypes].sort(), permissions: policy.permissions, lockedSectionIds: [...policy.lockedSectionIds].sort() };
}

export function contractVersion() {
  const source = { modules: allModuleContracts(), capabilities: loadPageCapabilities(), commands: Object.keys(COMMAND_PAYLOAD_SCHEMAS).sort().map((command) => commandContract(command)) };
  return `v1-${hash(stable(source))}`;
}

export function contractEnvelope<T>(value: T) {
  return { contractVersion: contractVersion(), ...value };
}
