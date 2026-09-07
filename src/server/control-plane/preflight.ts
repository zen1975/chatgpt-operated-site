import { env } from 'cloudflare:workers';
import { CommandEnvelope, COMMAND_PAYLOAD_SCHEMAS } from '../command-schema';
import { CommandError } from '../core/errors';
import { preflightPageCommand } from '../page-composition/mutations';
import { commandDigest } from './digest';
import { contractVersion } from './contracts';

const PAGE_COMMANDS = new Set(['create_page', 'update_page', 'insert_page_section', 'update_page_section', 'remove_page_section', 'reorder_page_sections', 'replace_page_section_asset', 'rollback_page', 'insert_page_section_item', 'update_page_section_item', 'remove_page_section_item', 'reorder_page_section_items', 'replace_page_section_item_asset']);
const PRODUCT_COMMANDS = new Set(['update_product', 'publish_product', 'archive_product', 'replace_product_asset', 'attach_product_asset', 'remove_product_asset', 'reorder_product_assets', 'rollback_product']);
const CONTENT_COMMANDS = new Set(['update_content', 'archive_content', 'rollback_content', 'schedule_content', 'attach_asset', 'replace_asset', 'update_seo']);

function stale(code: string, expectedVersion: number, currentVersion: number) {
  throw new CommandError('CONFLICT', code, 'The current version does not match expectedVersion.', false, { expectedVersion, currentVersion });
}

/** Validate a complete command envelope without invoking any mutation service. */
export async function preflightCommand(input: unknown) {
  const envelope = CommandEnvelope.parse(input);
  const digest = await commandDigest(envelope);
  const success = (result: Record<string, unknown>) => ({ ...result, commandDigest: digest, contractVersion: contractVersion(), validatedAt: new Date().toISOString(), sideEffects: false });
  const schema = COMMAND_PAYLOAD_SCHEMAS[envelope.command as keyof typeof COMMAND_PAYLOAD_SCHEMAS];
  if (!schema) throw new CommandError('USER_CORRECTABLE', 'PREFLIGHT_CONTRACT_MISSING', `No command contract is registered: ${envelope.command}`);
  const payload: any = schema.parse(envelope.payload);
  if (PAGE_COMMANDS.has(envelope.command)) return success({ ...await preflightPageCommand(envelope.command, payload), commandId: envelope.commandId });

  if (envelope.command === 'create_product' || envelope.command === 'create_news' || envelope.command === 'create_timed_content') {
    if ('expectedVersion' in payload && payload.expectedVersion !== undefined && payload.expectedVersion !== null && payload.expectedVersion !== 0) stale('VERSION_CONFLICT', payload.expectedVersion, 0);
    return success({ ok: true, command: envelope.command, commandId: envelope.commandId });
  }

  if (PRODUCT_COMMANDS.has(envelope.command)) {
    const productId = payload.productId;
    const row = await env.DB.prepare('SELECT version FROM products WHERE id=? LIMIT 1').bind(productId).first<{ version: number }>();
    if (!row) throw new CommandError('USER_CORRECTABLE', 'PRODUCT_NOT_FOUND', 'Product was not found.');
    if (row.version !== payload.expectedVersion) stale('PRODUCT_VERSION_CONFLICT', payload.expectedVersion, row.version);
    return success({ ok: true, command: envelope.command, commandId: envelope.commandId, currentVersion: row.version });
  }

  if (CONTENT_COMMANDS.has(envelope.command)) {
    const row = await env.DB.prepare('SELECT version FROM news WHERE id=? AND content_type=? LIMIT 1').bind(payload.contentId, payload.contentType).first<{ version: number }>();
    if (!row) throw new CommandError('USER_CORRECTABLE', 'CONTENT_NOT_FOUND', 'Content was not found.');
    if (row.version !== payload.expectedVersion) stale('CONTENT_VERSION_CONFLICT', payload.expectedVersion, row.version);
    return success({ ok: true, command: envelope.command, commandId: envelope.commandId, currentVersion: row.version });
  }

  return success({ ok: true, command: envelope.command, commandId: envelope.commandId });
}
