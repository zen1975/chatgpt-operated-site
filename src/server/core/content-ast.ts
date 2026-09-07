import { z } from 'zod';

export const ContentBlock = z.discriminatedUnion('type', [
  z.object({type:z.literal('paragraph'), content:z.string().min(1)}).strict(),
  z.object({type:z.literal('heading'), level:z.union([z.literal(2),z.literal(3),z.literal(4)]), content:z.string().min(1)}).strict(),
  z.object({type:z.literal('unordered_list'), items:z.array(z.string().min(1)).min(1)}).strict(),
  z.object({type:z.literal('ordered_list'), items:z.array(z.string().min(1)).min(1)}).strict(),
  z.object({type:z.literal('quote'), content:z.string().min(1)}).strict(),
  z.object({type:z.literal('image'), assetId:z.string().min(1), alt:z.string().default('')}).strict(),
  z.object({type:z.literal('table'), headers:z.array(z.string()), rows:z.array(z.array(z.string()))}).strict(),
  z.object({type:z.literal('reusable'), ref:z.string().min(1)}).strict(),
  z.object({type:z.literal('separator')}).strict()
]);

export const ContentAST = z.array(ContentBlock).min(1);
export type ContentBlockType = z.infer<typeof ContentBlock>;
export type ContentASTType = z.infer<typeof ContentAST>;

export type ContentAstAssetReference = { assetId: string; path: string };

/**
 * The asset references a content body carries.
 *
 * Lives beside the schema that defines those blocks, so the shape and the way
 * assets are found from it cannot drift apart, and both the Worker and the
 * dispatch gate read assets from this one function. Deliberately not a generic
 * search for keys called `assetId`: only the `image` block declares one, and a
 * paragraph or link that happened to contain such a key is not an asset.
 */
export function extractContentAstAssetReferences(blocks: unknown): ContentAstAssetReference[] {
  if (!Array.isArray(blocks)) return [];
  const references: ContentAstAssetReference[] = [];
  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return;
    const candidate = block as { type?: unknown; assetId?: unknown };
    if (candidate.type !== 'image') return;
    if (typeof candidate.assetId !== 'string' || !candidate.assetId) return;
    references.push({ assetId: candidate.assetId, path: `blocks[${index}].assetId` });
  });
  return references;
}
