import { db } from './db';
import { ContentAST, type ContentASTType, type ContentBlockType } from '@/server/core/content-ast';

const MAX_REUSABLE_DEPTH = 4;

type ReusableDatabase = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => { first: <T>() => Promise<T | null> };
  };
};

/**
 * Strict validation shared by write paths that must reject an unresolved
 * reusable pattern. Article rendering intentionally keeps its visible
 * unsupported-block behavior; Page mutations use this fail-closed helper.
 */
export async function assertReusablePatternTree(reference: string, database: ReusableDatabase, depth = 0, seen = new Set<string>()): Promise<string[]> {
  if (depth >= MAX_REUSABLE_DEPTH) throw new Error('REUSABLE_DEPTH_EXCEEDED');
  if (seen.has(reference)) throw new Error('REUSABLE_CYCLE');
  const pattern = await database.prepare('SELECT id,slug,blocks_json FROM reusable_patterns WHERE id=? OR slug=? LIMIT 1').bind(reference, reference).first<{ id: string; slug: string; blocks_json: string }>();
  if (!pattern) throw new Error('REUSABLE_NOT_FOUND');
  let parsed: unknown;
  try { parsed = JSON.parse(pattern.blocks_json); } catch { throw new Error('REUSABLE_INVALID_AST'); }
  const canonical = ContentAST.safeParse(parsed);
  if (!canonical.success) throw new Error('REUSABLE_INVALID_AST');
  const nextSeen = new Set(seen);
  nextSeen.add(reference);
  const assetIds: string[] = [];
  for (const block of canonical.data) {
    if (block.type === 'image') assetIds.push(block.assetId);
    if (block.type === 'reusable') assetIds.push(...await assertReusablePatternTree(block.ref, database, depth + 1, nextSeen));
  }
  return assetIds;
}

/** Resolve only approved D1 reusable_patterns records into Canonical AST.
 * No HTML, component source, or arbitrary markup is accepted. Missing,
 * invalid, cyclic, or too-deep references remain explicit reusable blocks so
 * the renderer can expose a visible unsupported state. */
export async function expandReusableBlocks(blocks: ContentASTType, depth = 0, seen = new Set<string>()): Promise<ContentASTType> {
  const output: ContentBlockType[] = [];
  for (const block of blocks) {
    if (block.type !== 'reusable') {
      output.push(block);
      continue;
    }
    if (depth >= MAX_REUSABLE_DEPTH || seen.has(block.ref)) {
      output.push(block);
      continue;
    }
    const pattern = await db().prepare('SELECT id,slug,blocks_json FROM reusable_patterns WHERE id=? OR slug=? LIMIT 1').bind(block.ref, block.ref).first<{ id: string; slug: string; blocks_json: string }>();
    if (!pattern) {
      output.push(block);
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(pattern.blocks_json); } catch { output.push(block); continue; }
    const canonical = ContentAST.safeParse(parsed);
    if (!canonical.success) {
      output.push(block);
      continue;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(block.ref);
    output.push(...await expandReusableBlocks(canonical.data, depth + 1, nextSeen));
  }
  return output;
}
