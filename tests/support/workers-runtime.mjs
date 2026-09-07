import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../../scripts/repo-root.mjs';

/**
 * A D1-shaped adapter over node:sqlite, so tests can drive the real handlers
 * instead of re-typing their SQL.
 *
 * Every defect in this area was missed by tests that asserted on source text or
 * ran their own statements: a handler can pass those while still handing raw
 * statements to fencedBatch, or querying D1 for a row it has not written yet.
 * Only entering at the handler catches that.
 */
function d1(db) {
  const prepare = (sql, params = []) => ({
    __sql: sql,
    __params: params,
    bind: (...values) => prepare(sql, values),
    first: async (column) => {
      const row = db.prepare(sql).get(...params) ?? null;
      return row && column ? row[column] : row;
    },
    run: async () => {
      const outcome = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(outcome.changes ?? 0) } };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...params), meta: {} })
  });

  return {
    prepare: (sql) => prepare(sql),
    async batch(statements) {
      // D1 batches are transactions: a failing statement rolls the sequence
      // back. Reproduced so fencing behaves as it does in production.
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          if (!statement || typeof statement.__sql !== 'string') {
            // Exactly what a raw statement or a bad cast produces.
            throw new TypeError('batch received a value that is not a prepared statement');
          }
          const outcome = db.prepare(statement.__sql).run(...statement.__params);
          return { success: true, results: [], meta: { changes: Number(outcome.changes ?? 0) } };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    }
  };
}

/** A content-addressed object store, as R2 is used here. */
function r2() {
  const objects = new Map();
  return {
    store: objects,
    async head(key) { return objects.has(key) ? { key, size: 1 } : null; },
    async get(key) { return objects.has(key) ? { key, arrayBuffer: async () => objects.get(key) } : null; },
    async put(key, value) { objects.set(key, value); return { key, size: 1 }; },
    async delete(key) { objects.delete(key); }
  };
}

/** A migrated database plus the runtime the Worker code reads. */
export async function installWorkerRuntime(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  const files = (await readdir(path.join(repoRoot, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) db.exec(await readFile(path.join(repoRoot, 'migrations', name), 'utf8'));

  const storage = r2();
  const runtime = {
    DB: d1(db),
    ASSETS_BUCKET: storage,
    SESSION: { async get() { return null; }, async put() {}, async delete() {} },
    SITE_ORIGIN: 'https://example.com',
    SITE_TIMEZONE: 'UTC',
    COMMAND_HMAC_SECRET: 'test-secret',
    COMMAND_TRUSTED_ACTOR: 'github-actions',
    COMMAND_TRUSTED_SCOPES: '*',
    ...overrides
  };

  globalThis.__WORKERS_TEST_ENV__ = runtime;
  return {
    db,
    storage,
    runtime,
    dispose() {
      delete globalThis.__WORKERS_TEST_ENV__;
      db.close();
    }
  };
}
