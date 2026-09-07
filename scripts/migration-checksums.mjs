// Pins the content of every committed migration.
//
// "Append-only" is not the same as "no destructive statements". A contributor
// can add a column to 0001_initial.sql with perfectly non-destructive SQL, and
// every other check still passes -- but existing installations have already run
// 0001 and will never re-run it, so they permanently diverge from a database
// built fresh. The only safe edit to an applied migration is no edit at all.
//
// Checksums make that visible: changing an existing migration forces a
// regenerated manifest, and the changed digest for an already-released file is
// the signal a reviewer needs. Deliberately checksum-based rather than
// diff-against-base, so the check also works where there is no git metadata.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';

const migrationsDir = path.join(repoRoot, 'migrations');
export const MANIFEST_PATH = 'migrations/CHECKSUMS.json';

export async function migrationFiles() {
  return (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
}

export async function computeChecksums() {
  const checksums = {};
  for (const name of await migrationFiles()) {
    const contents = await readFile(path.join(migrationsDir, name));
    checksums[name] = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
  }
  return checksums;
}

export const serialize = (checksums) =>
  `${JSON.stringify(
    {
      $comment:
        'Content digests of applied migrations. Regenerate with `npm run migrations:checksums` ONLY when adding a new migration. A changed digest for an existing migration means an already-applied file was edited, which silently diverges existing installations from fresh ones.',
      checksums
    },
    null,
    2
  )}\n`;

if (import.meta.filename === process.argv[1]) {
  const checksums = await computeChecksums();
  await writeFile(path.join(repoRoot, MANIFEST_PATH), serialize(checksums), 'utf8');
  console.log(`wrote ${MANIFEST_PATH} (${Object.keys(checksums).length} migrations)`);
}
