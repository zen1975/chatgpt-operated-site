import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/load-command-contracts.mjs';

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
