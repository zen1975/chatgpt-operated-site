import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { computeChecksums, serialize, MANIFEST_PATH } from '../scripts/migration-checksums.mjs';

// D1 is SQLite. Applying the committed migrations to an empty in-process
// SQLite database is the cheapest reproduction of "a third party provisions a
// brand new D1 and runs `npm run db:migrate:remote`" that does not require a
// Cloudflare account.
const migrationsDir = path.join(repoRoot, 'migrations');
const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

test('migrations are numbered sequentially from 0001', () => {
  assert.ok(files.length > 0, 'migrations/ must not be empty');
  files.forEach((name, index) => {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/, `unexpected migration filename: ${name}`);
    assert.equal(Number(name.slice(0, 4)), index + 1, `migration ${name} breaks the sequence`);
  });
});

test('migrations apply in order to a brand new database', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of files) {
      const sql = await readFile(path.join(migrationsDir, name), 'utf8');
      try {
        db.exec(sql);
      } catch (error) {
        assert.fail(`migration ${name} failed on a fresh database: ${error.message}`);
      }
    }

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => row.name);

    // The tables the command pipeline reads and writes on every mutation.
    for (const required of ['news', 'jobs', 'assets', 'content_assets', 'content_term_links', 'taxonomy_terms', 'search_documents', 'pages', 'products']) {
      assert.ok(tables.includes(required), `expected table ${required} after migrations; got ${tables.join(', ')}`);
    }
  } finally {
    db.close();
  }
});

test('migrations are append-only: no destructive statements', async () => {
  for (const name of files) {
    const sql = await readFile(path.join(migrationsDir, name), 'utf8');
    const stripped = sql.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(stripped, /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+_)/i, `${name} drops a table; migrations are documented as append-only`);
    assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i, `${name} deletes rows; migrations are documented as append-only`);
  }
});

// Rejecting destructive statements is not immutability. A migration edited with
// entirely non-destructive SQL -- a column added to 0001 rather than a new 0006
// -- passes every other check here, yet existing installations have already run
// that file and will never re-run it, so they diverge permanently from a
// database built fresh. The committed digests make such an edit impossible to
// land silently.
test('the migration checksum manifest matches the committed migrations', async () => {
  const committed = await readFile(path.join(repoRoot, MANIFEST_PATH), 'utf8');
  assert.equal(
    committed,
    serialize(await computeChecksums()),
    `${MANIFEST_PATH} is stale. If you added a migration, run \`npm run migrations:checksums\` and commit it. If the digest of an EXISTING migration changed, an already-applied file was edited: revert it and add a new migration instead.`
  );
});

test('the checksum manifest covers exactly the committed migrations', async () => {
  const { checksums } = JSON.parse(await readFile(path.join(repoRoot, MANIFEST_PATH), 'utf8'));
  assert.deepEqual(Object.keys(checksums).sort(), files, 'every migration must be pinned, and the manifest must not pin files that no longer exist');
  for (const digest of Object.values(checksums)) assert.match(digest, /^sha256:[a-f0-9]{64}$/);
});
