import { extractContentAstAssetReferences } from './core/content-ast';
import { extractModuleAssetReferences, MODULE_REGISTRY } from './page-composition/registry';
import { AssetId } from './page-composition/schemas';

/**
 * Where a command's assets live, and what that means for the operating
 * contract.
 *
 * One definition, shared by the Worker and the dispatch gate. Both previously
 * grew their own partial answers -- first a list of command names, then a
 * page-only extension -- and each time a payload shape that could carry an
 * asset was missed: a ContentAST image block, a product's primaryAssetId.
 *
 * Extraction always defers to the schema that owns the shape:
 *   - content bodies      -> extractContentAstAssetReferences (core/content-ast)
 *   - page module props   -> extractModuleAssetReferences (page-composition)
 *   - product asset field -> the canonical AssetId schema
 *
 * There is deliberately no generic search for fields named `assetId`.
 */

export type CommandAssetReference = { assetId: string; path: string; source: string };

/**
 * How a command relates to assets.
 *
 * `intrinsic`      placing an asset is the operation itself.
 * `payload-derived` image-bearing only when this particular payload carries an
 *                  asset in a declared position.
 * `non-image`      never image-bearing. Some of these still mention asset ids --
 *                  reorder passes them, rollback restores them -- but they
 *                  bring no asset in, which is what the contract's flag is
 *                  about. "The payload contains an asset id" and "the operation
 *                  is image-bearing" are not the same statement.
 */
export type AssetSemantics = 'intrinsic' | 'payload-derived' | 'non-image';

export type CommandAssetSemantics = {
  readonly semantics: AssetSemantics;
  readonly reason: string;
  /** The schema or registry that decides, for a payload-derived command. */
  readonly source?: string;
};

/**
 * Every command in the envelope, classified. A contract test fails when this
 * map and COMMAND_PAYLOAD_SCHEMAS disagree, so a new command cannot be added
 * without deciding what it means for assets.
 */
export const COMMAND_ASSET_SEMANTICS: Record<string, CommandAssetSemantics> = {
  // --- intrinsic: the operation exists to place an asset ---------------------
  import_wordpress_asset: { semantics: 'intrinsic', reason: 'imports media from WordPress into the Asset Engine' },
  attach_asset: { semantics: 'intrinsic', reason: 'attaches a canonical asset to content' },
  replace_asset: { semantics: 'intrinsic', reason: 'replaces a content asset by canonical id or provider reference' },
  attach_product_asset: { semantics: 'intrinsic', reason: 'attaches a canonical asset to a product' },
  replace_product_asset: { semantics: 'intrinsic', reason: 'replaces a product asset by canonical id or provider reference' },
  replace_page_section_asset: { semantics: 'intrinsic', reason: 'replaces a section asset by canonical id or provider reference' },
  replace_page_section_item_asset: { semantics: 'intrinsic', reason: 'replaces an item asset by canonical id' },

  // --- payload-derived: image-bearing only when the payload carries an asset -
  create_news: { semantics: 'payload-derived', reason: 'its content body may contain image blocks', source: 'ContentAST image blocks' },
  update_content: { semantics: 'payload-derived', reason: 'a changed content body may contain image blocks', source: 'ContentAST image blocks' },
  create_product: { semantics: 'payload-derived', reason: 'may name a canonical primary asset', source: 'CreateProductPayload.primaryAssetId' },
  create_page: { semantics: 'payload-derived', reason: 'seeds sections whose module props may hold a canonical asset', source: 'page module registry' },
  insert_page_section: { semantics: 'payload-derived', reason: 'inserts a module whose props may hold a canonical asset', source: 'page module registry' },
  update_page_section: { semantics: 'payload-derived', reason: 'replaces module props, which may hold a canonical asset', source: 'page module registry' },
  insert_page_section_item: { semantics: 'payload-derived', reason: 'inserts an item whose declared slot may hold a canonical asset', source: 'page module registry item slots' },
  update_page_section_item: { semantics: 'payload-derived', reason: 'replaces an item whose declared slot may hold a canonical asset', source: 'page module registry item slots' },

  // --- non-image ------------------------------------------------------------
  create_taxonomy_term: { semantics: 'non-image', reason: 'creates a taxonomy term; carries no asset' },
  create_timed_content: { semantics: 'non-image', reason: 'carries text and a link only; its payload has no asset field' },
  archive_content: { semantics: 'non-image', reason: 'changes content status by id; carries no asset' },
  schedule_content: { semantics: 'non-image', reason: 'changes a publication window; carries no asset' },
  update_seo: { semantics: 'non-image', reason: 'changes SEO title and description text only' },
  rollback_content: { semantics: 'non-image', reason: 'names a stored revision; the assets it restores are already registered and are not carried in the payload' },
  update_product: { semantics: 'non-image', reason: 'changes product fields; its override fields are same-origin paths, not canonical asset ids' },
  publish_product: { semantics: 'non-image', reason: 'changes publication status and date; carries no asset' },
  archive_product: { semantics: 'non-image', reason: 'changes product status to archived; carries no asset' },
  rollback_product: { semantics: 'non-image', reason: 'names a stored revision; restored assets are already registered' },
  remove_product_asset: { semantics: 'non-image', reason: 'detaches by role and position; brings no asset in' },
  reorder_product_assets: { semantics: 'non-image', reason: 'reorders assets already attached. It passes asset ids, but introduces none -- the flag is about bringing an asset in, not about mentioning one' },
  update_page: { semantics: 'non-image', reason: 'changes page metadata; module props are not part of its payload' },
  remove_page_section: { semantics: 'non-image', reason: 'removes a section by id; carries no module props' },
  reorder_page_sections: { semantics: 'non-image', reason: 'reorders sections by id only; introduces nothing' },
  rollback_page: { semantics: 'non-image', reason: 'names a stored revision; restored assets are already registered' },
  remove_page_section_item: { semantics: 'non-image', reason: 'removes an item by id; carries no item body' },
  reorder_page_section_items: { semantics: 'non-image', reason: 'reorders items by id only; introduces nothing' }
};

/** Item-level asset slots, derived from the module registry rather than listed. */
function itemAssetSlotNames() {
  const names = new Set<string>();
  for (const entry of Object.values(MODULE_REGISTRY)) {
    for (const slot of Object.keys(entry.assetFields as Record<string, string>)) {
      const match = slot.match(/^items\[\]\.(.+)$/);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

const asRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function sectionReferences(section: unknown, source: string): CommandAssetReference[] {
  const record = asRecord(section);
  if (!record || typeof record.sectionType !== 'string') return [];
  try {
    return extractModuleAssetReferences({ sectionType: record.sectionType, props: record.props })
      .map((reference) => ({ assetId: reference.assetId, path: reference.assetPath, source }));
  } catch {
    // An unregistered module type is the schema gate's business, not this one's.
    return [];
  }
}

/**
 * Canonical asset references carried by a validated payload.
 *
 * Only positions the owning schema declares are considered, and a value must
 * parse as a canonical asset id where the schema says one belongs.
 */
export function extractCommandAssetReferences(command: string, validatedPayload: unknown): CommandAssetReference[] {
  const payload = asRecord(validatedPayload);
  if (!payload) return [];

  switch (command) {
    case 'create_news':
      return extractContentAstAssetReferences(payload.blocks).map((reference) => ({ ...reference, source: 'ContentAST image block' }));

    case 'update_content': {
      const changes = asRecord(payload.changes);
      return extractContentAstAssetReferences(changes?.blocks).map((reference) => ({ ...reference, source: 'ContentAST image block' }));
    }

    case 'create_product':
      return AssetId.safeParse(payload.primaryAssetId).success
        ? [{ assetId: payload.primaryAssetId as string, path: 'primaryAssetId', source: 'CreateProductPayload.primaryAssetId' }]
        : [];

    case 'create_page':
      return (Array.isArray(payload.sections) ? payload.sections : []).flatMap((section) => sectionReferences(section, 'page module slot'));

    case 'insert_page_section':
    case 'update_page_section':
      return sectionReferences(payload, 'page module slot');

    case 'insert_page_section_item':
    case 'update_page_section_item': {
      const item = asRecord(payload.item);
      if (!item) return [];
      return [...itemAssetSlotNames()]
        .filter((slot) => AssetId.safeParse(item[slot]).success)
        .map((slot) => ({ assetId: item[slot] as string, path: `item.${slot}`, source: 'page module item slot' }));
    }

    default:
      return [];
  }
}

/**
 * Whether an operation is image-bearing under the operating contract.
 *
 * Intrinsic commands always are. Payload-derived commands are when this
 * payload actually carries an asset. Non-image commands never are, even when
 * their payload mentions asset ids.
 */
export function isImageBearingOperation(command: string, validatedPayload: unknown): boolean {
  const semantics = COMMAND_ASSET_SEMANTICS[command]?.semantics;
  if (semantics === 'intrinsic') return true;
  if (semantics === 'payload-derived') return extractCommandAssetReferences(command, validatedPayload).length > 0;
  return false;
}
