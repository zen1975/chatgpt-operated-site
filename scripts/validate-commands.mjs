#!/usr/bin/env node
/**
 * Validate committed commands against the distributed contracts (schemas/*.json)
 * before anything is dispatched.
 *
 * Usage: node scripts/validate-commands.mjs [directory]   (default: commands)
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';
import { loadCommandContracts } from './load-command-contracts.mjs';

const dir = path.join(repoRoot, process.argv[2] || 'commands');

async function jsonFiles(root) {
  const found = [];
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.json')) found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * commandId is the key that decides whether a command has already run. If two
 * different files carry the same id, the worker treats the second one as a
 * replay and returns success without applying anything (see the idempotency
 * check in src/server/commands.ts). The requester is told the change was
 * registered and the site does not change.
 *
 * That is the hardest failure of this system to notice, so it is rejected here,
 * before dispatch. This check reads the parsed JSON rather than the file text,
 * so reformatting cannot hide a duplicate.
 *
 * The whole operation log is scanned, not only the directory being validated,
 * because the collision that matters is with a command that already ran.
 */
async function duplicateCommandIds() {
  const seen = new Map();
  const roots = [...new Set([path.join(repoRoot, 'commands'), dir])];
  const files = (await Promise.all(roots.map(jsonFiles))).flat();
  for (const full of [...new Set(files)]) {
    try {
      const doc = JSON.parse(await readFile(full, 'utf8'));
      if (!doc?.commandId) continue;
      const rel = path.relative(repoRoot, full);
      seen.set(doc.commandId, [...(seen.get(doc.commandId) || []), rel]);
    } catch { /* unparseable files are reported by the contract check below */ }
  }
  return [...seen.entries()].filter(([, files]) => files.length > 1);
}

const duplicates = await duplicateCommandIds();
if (duplicates.length) {
  console.log(`duplicate commandId: ${duplicates.length}`);
  for (const [id, files] of duplicates) console.log(' x', id, '->', files.join(', '));
  console.log('  A repeated commandId is treated as already executed: success is returned and nothing is applied.');
  process.exit(1);
}

const contracts = await loadCommandContracts();
const files = await jsonFiles(dir);
let ok = 0;
const failures = [];
for (const full of files) {
  const rel = path.relative(repoRoot, full);
  let doc;
  try { doc = JSON.parse(await readFile(full, 'utf8')); }
  catch (e) { failures.push({ file: rel, issues: [`invalid JSON: ${String(e.message).slice(0, 120)}`] }); continue; }
  try {
    contracts.CommandEnvelope.parse(doc);
    const schema = contracts.COMMAND_PAYLOAD_SCHEMAS[doc.command];
    if (!schema) throw new Error(`unknown command: ${doc.command}`);
    schema.parse(doc.payload);
    ok += 1;
  } catch (e) {
    const issues = e?.issues?.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) ?? [String(e.message).slice(0, 160)];
    failures.push({ file: rel, issues });
  }
}
console.log(`contract check: ${ok}/${files.length} valid`);
for (const f of failures.slice(0, 15)) console.log(' x', f.file, JSON.stringify(f.issues));
if (failures.length > 15) console.log(`  ... and ${failures.length - 15} more`);
process.exit(failures.length ? 1 : 0);
