// Extracts the environment names the Worker actually reads.
//
// The implementation reaches the runtime environment two ways: directly, as
// `env.NAME`, and through a widening cast, `env as typeof env & { NAME?: ... }`
// followed by `configured.NAME`. Both are collected here so that adding a new
// read to src/ fails the contract checks until the name is typed in
// src/env.d.ts and documented in docs/CONFIGURATION.md.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.mjs', '.js']);

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(absolute)));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(absolute);
  }
  return found;
}

/** Names that are runtime API surface rather than configuration. */
const NOT_CONFIGURATION = new Set(['DB', 'ASSETS_BUCKET', 'SESSION']);

export async function collectRuntimeConfigReads() {
  const files = await sourceFiles(path.join(repoRoot, 'src'));
  const reads = new Map();

  const record = (name, file) => {
    const relative = path.relative(repoRoot, file);
    if (!reads.has(name)) reads.set(name, new Set());
    reads.get(name).add(relative);
  };

  for (const file of files) {
    if (file.endsWith(path.join('src', 'env.d.ts'))) continue;
    const source = await readFile(file, 'utf8');

    for (const [, name] of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) record(name, file);

    // `env as typeof env & { NAME?: string; OTHER?: string }`
    for (const [, block] of source.matchAll(/env\s+as\s+typeof\s+env\s*&\s*\{([^}]*)\}/g)) {
      for (const [, name] of block.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*\??\s*:/g)) record(name, file);
    }
  }

  return reads;
}

/** Every environment name the Worker reads, excluding the resource bindings. */
export async function collectRuntimeConfigNames() {
  const reads = await collectRuntimeConfigReads();
  return [...reads.keys()].filter((name) => !NOT_CONFIGURATION.has(name)).sort();
}

export { NOT_CONFIGURATION };
