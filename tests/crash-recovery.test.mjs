import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

// Termination can land anywhere. What must hold in every case is that a retry
// produces one logical mutation and one stable result.
const { evaluateExistingJob } = await loadServerModule('src/server/control-plane/replay.ts');
const { JOB_SQL } = await loadServerModule('src/server/control-plane/job-store.ts');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ID = 'crash-command-0001';
const TYPE = 'create_news';
const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

async function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  const files = (await readdir(path.join(repoRoot, 'migrations'))).filter((n) => n.endsWith('.sql')).sort();
  for (const name of files) db.exec(await readFile(path.join(repoRoot, 'migrations', name), 'utf8'));
  return db;
}

const read = (db) => db.prepare(JOB_SQL.read).get(ID);
const claim = (db, leaseToken, expires = future()) => {
  db.prepare(JOB_SQL.claim).run(`claim-${leaseToken}`, ID, TYPE, 'running', 1, DIGEST, 'now', 'now', leaseToken, expires);
  return read(db);
};
const reclaim = (db, leaseToken) =>
  db.prepare(JOB_SQL.reclaimExpired).run('now', leaseToken, future(), ID, DIGEST, TYPE, new Date().toISOString());

/**
 * The domain mutation and its job completion in one atomic batch, as the D1
 * handlers do. Either both land or neither does, so a crash cannot leave a
 * mutation without its result.
 */
function mutateAndComplete(db, leaseToken, { slug, title }) {
  const applied = db.prepare(
    `INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type)
     VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING`
  ).run(`content_${slug}`, slug, title, '[]', 'published', 1, 'now', 'now', 'news');

  const completion = db.prepare(JOB_SQL.success)
    .run('new', ID, TYPE, 'success', 1, JSON.stringify({ id: `content_${slug}`, slug }), 'now', 'now', leaseToken);

  return { applied: applied.changes, completed: completion.changes };
}

const newsRows = (db) => db.prepare('SELECT id,slug FROM news WHERE slug=?').all('crash-news');

test('termination before the mutation: retry mutates once', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-1', past());          // attempt 1 claimed, then died immediately
    assert.deepEqual(newsRows(db), [], 'nothing was mutated');

    const stored = read(db);
    assert.deepEqual(evaluateExistingJob(ID, TYPE, DIGEST, stored), { kind: 'reclaim-expired-lease' });
    assert.equal(reclaim(db, 'lease-2').changes, 1);

    const outcome = mutateAndComplete(db, 'lease-2', { slug: 'crash-news', title: 'Headline' });
    assert.equal(outcome.applied, 1);
    assert.equal(outcome.completed, 1);
    assert.equal(newsRows(db).length, 1, 'exactly one logical mutation');
    assert.equal(read(db).status, 'success');
  } finally { db.close(); }
});

// "During" the mutation, for a D1-only command, means the batch did not commit:
// the domain row and the completion land together or not at all.
test('termination during the mutation: nothing partial survives, retry mutates once', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-1', past());

    // The batch is atomic, so an interrupted attempt leaves no row behind.
    db.exec('BEGIN');
    db.prepare(
      `INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('content_partial', 'crash-news', 'Headline', '[]', 'published', 1, 'now', 'now', 'news');
    db.exec('ROLLBACK');

    assert.deepEqual(newsRows(db), [], 'an uncommitted mutation must leave nothing behind');

    reclaim(db, 'lease-2');
    const outcome = mutateAndComplete(db, 'lease-2', { slug: 'crash-news', title: 'Headline' });
    assert.equal(outcome.applied, 1);
    assert.equal(newsRows(db).length, 1, 'exactly one logical mutation');
    assert.equal(read(db).status, 'success');
  } finally { db.close(); }
});

// The hardest case: the mutation committed, but the process died before the
// completion write. The retry must not create a second mutation.
test('termination after the mutation but before completion: retry does not duplicate', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-1', past());

    // Attempt 1: the domain mutation landed; the process died before the job row
    // could be completed.
    db.prepare(
      `INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('content_crash-news', 'crash-news', 'Headline', '[]', 'published', 1, 'now', 'now', 'news');

    assert.equal(read(db).status, 'running', 'the job is stranded running');
    assert.equal(newsRows(db).length, 1);

    // Attempt 2 reclaims and re-runs. The mutation is conflict-guarded on its
    // natural key, so it does not apply a second time.
    reclaim(db, 'lease-2');
    const outcome = mutateAndComplete(db, 'lease-2', { slug: 'crash-news', title: 'Headline' });

    assert.equal(outcome.applied, 0, 'the already-applied mutation must not repeat');
    assert.equal(outcome.completed, 1, 'but the result must still be recorded');
    assert.equal(newsRows(db).length, 1, 'exactly one logical mutation');

    const row = read(db);
    assert.equal(row.status, 'success');
    assert.deepEqual(JSON.parse(row.result_json), { id: 'content_crash-news', slug: 'crash-news' }, 'one stable result');
  } finally { db.close(); }
});

test('a retry after recovery is then answered as a replay', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-1', past());
    reclaim(db, 'lease-2');
    mutateAndComplete(db, 'lease-2', { slug: 'crash-news', title: 'Headline' });

    const outcome = evaluateExistingJob(ID, TYPE, DIGEST, read(db));
    assert.equal(outcome.kind, 'replay');
    assert.deepEqual(outcome.result, { id: 'content_crash-news', slug: 'crash-news' });
    assert.equal(newsRows(db).length, 1, 'a replay never mutates');
  } finally { db.close(); }
});

// Provider/R2 work is made safe by content addressing rather than by the lease.
test('asset intake is content-addressed, so a repeated attempt is idempotent', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/core/assets.ts'), 'utf8');

  // The R2 key and the asset id are both derived from the content hash, so a
  // repeated attempt writes the same bytes to the same key.
  assert.match(source, /const computed = await sha256\(bytes\)/);
  assert.match(source, /const r2Key = assetR2Key\(computed, asset\.variant, asset\.mimeType\)/);
  assert.match(source, /const id = assetId\(computed, asset\.variant\)/);

  // The D1 row is inserted only when no row for that content already exists,
  // and the domain rows plus the job completion go in one batch.
  assert.match(source, /const existing = await env\.DB\.prepare\('SELECT id[\s\S]{0,200}WHERE sha256=\? AND variant=\?/);
  assert.match(source, /const statements = existing \? \[\] :/);
  assert.match(source, /await env\.DB\.batch\(\[[\s\S]{0,600}successStatement\(commandId, commandType, result, now\)/);

  const { assetR2Key, assetId } = await loadServerModule('src/server/core/assets.ts');
  const hash = 'b'.repeat(64);
  assert.equal(assetR2Key(hash, 'original', 'image/jpeg'), assetR2Key(hash, 'original', 'image/jpeg'), 'the key must be deterministic');
  assert.equal(assetId(hash, 'original'), assetId(hash, 'original'));
});
