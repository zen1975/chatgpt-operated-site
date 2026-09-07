import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

// D1 batches are SQL transactions: "if a statement in the sequence fails... it
// aborts or rolls back the entire sequence". Fencing therefore has to be a
// statement that FAILS when the lease is gone -- a conditional update that
// merely matches zero rows is not an error and cannot abort anything.
const { JOB_SQL, LEASE_DURATION_MS } = await loadServerModule('src/server/control-plane/job-store.ts');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ID = 'fence-command-0001';
const TYPE = 'create_news';
const future = () => new Date(Date.now() + LEASE_DURATION_MS).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

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
 * A fenced batch, as D1 runs one: the fence first, everything inside a
 * transaction, and any failure rolling the whole thing back.
 */
function fencedBatch(db, leaseToken, statements) {
  db.exec('BEGIN');
  try {
    db.prepare(JOB_SQL.fence).run(ID, leaseToken, ID, leaseToken, 'now');
    const results = statements.map(({ sql, params }) => db.prepare(sql).run(...params));
    db.exec('COMMIT');
    return { committed: true, results };
  } catch (error) {
    db.exec('ROLLBACK');
    return { committed: false, error };
  }
}

const insertNews = (id, slug) => ({
  sql: `INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type) VALUES (?,?,?,?,?,?,?,?,?)`,
  params: [id, slug, 'Headline', '[]', 'published', 1, 'now', 'now', 'news']
});
const insertRevision = (id) => ({
  sql: `INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  params: [id, 'news', id, 'create', null, '{}', ID, 'now']
});
const completeSuccess = (leaseToken, result) => ({
  sql: JOB_SQL.success,
  params: ['new', ID, TYPE, 'success', 1, JSON.stringify(result), 'now', 'now', leaseToken]
});

const newsRows = (db) => db.prepare('SELECT id FROM news').all();
const revisionRows = (db) => db.prepare('SELECT id FROM content_revisions').all();

// ---------------------------------------------------------- the interleaving

// One simulated isolate, both attempts alive, stepped deterministically.
test('A pauses, B reclaims, A resumes: A changes nothing and B completes', async () => {
  const db = await freshDatabase();
  try {
    // A obtains lease A.
    const executionA = { leaseToken: 'lease-A' };
    claim(db, executionA.leaseToken, past());          // already expired: A is about to be overtaken
    assert.equal(read(db).lease_token, 'lease-A');

    // A pauses before its mutation. B reclaims.
    const executionB = { leaseToken: 'lease-B' };
    assert.equal(reclaim(db, executionB.leaseToken).changes, 1);
    assert.equal(read(db).lease_token, 'lease-B');

    // A resumes. It still holds its own context and cannot see B's.
    assert.equal(executionA.leaseToken, 'lease-A', 'A must not have acquired B\'s token');
    assert.notEqual(executionA.leaseToken, executionB.leaseToken);

    // A's mutation batch is fenced and must roll back entirely.
    const attemptA = fencedBatch(db, executionA.leaseToken, [
      insertNews('content_A', 'from-attempt-a'),
      insertRevision('rev_A'),
      completeSuccess(executionA.leaseToken, { id: 'content_A' })
    ]);
    assert.equal(attemptA.committed, false, 'a superseded attempt must not commit');
    assert.match(String(attemptA.error), /holds_lease/);
    assert.deepEqual(newsRows(db), [], 'no content from the superseded attempt');
    assert.deepEqual(revisionRows(db), [], 'no revision from the superseded attempt');

    // A's completion affects no authoritative row, and A's failure recording
    // cannot touch the job either.
    const aCompletion = db.prepare(JOB_SQL.success).run('x', ID, TYPE, 'success', 1, '{}', 'now', 'now', executionA.leaseToken);
    assert.equal(aCompletion.changes, 0, "A's completion must affect zero rows");
    const aFailure = db.prepare(JOB_SQL.failure).run('x', ID, TYPE, 'failed', 1, null, null, null, 'now', 'now', executionA.leaseToken);
    assert.equal(aFailure.changes, 0, "A's failure must affect zero rows");
    assert.equal(read(db).status, 'running', 'A must not have moved the job');
    assert.equal(read(db).lease_token, 'lease-B', "A must not have deleted B's lease");

    // B proceeds and completes.
    const attemptB = fencedBatch(db, executionB.leaseToken, [
      insertNews('content_B', 'from-attempt-b'),
      insertRevision('rev_B'),
      completeSuccess(executionB.leaseToken, { id: 'content_B' })
    ]);
    assert.equal(attemptB.committed, true);

    assert.equal(newsRows(db).length, 1, 'exactly one logical mutation');
    assert.equal(newsRows(db)[0].id, 'content_B');
    const job = read(db);
    assert.equal(job.status, 'success', 'exactly one terminal result');
    assert.deepEqual(JSON.parse(job.result_json), { id: 'content_B' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
  } finally { db.close(); }
});

// --------------------------------------------------------- lease loss points

test('lease lost before a D1 batch: nothing commits', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A', past());
    reclaim(db, 'lease-B');

    const outcome = fencedBatch(db, 'lease-A', [insertNews('content_A', 'a'), completeSuccess('lease-A', {})]);
    assert.equal(outcome.committed, false);
    assert.deepEqual(newsRows(db), []);
  } finally { db.close(); }
});

// The R2 object is content-addressed, so a repeated write is harmless. Its D1
// registration is not, and must still be fenced.
test('lease lost between the R2 write and its D1 registration: no rows are registered', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A', past());

    // The content-addressed R2 put has already happened here. Then the lease is
    // lost, and only afterwards does the D1 registration run.
    reclaim(db, 'lease-B');

    const outcome = fencedBatch(db, 'lease-A', [
      { sql: `INSERT INTO assets (id,r2_key,original_filename,mime_type,bytes,alt,variant,created_at,source_provider,sha256,logical_asset_id,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [`asset_${'c'.repeat(64)}_original`, 'assets/cc.jpg', 'a.jpg', 'image/jpeg', 10, '', 'original', 'now', 'google_drive', 'c'.repeat(64), `logical_${'c'.repeat(64)}`, 'validated'] },
      insertRevision('rev_asset'),
      completeSuccess('lease-A', {})
    ]);

    assert.equal(outcome.committed, false, 'the D1 registration must roll back');
    assert.deepEqual(db.prepare('SELECT id FROM assets').all(), [], 'no asset row from a superseded attempt');
    assert.deepEqual(revisionRows(db), [], 'no revision from a superseded attempt');
  } finally { db.close(); }
});

test('lease lost immediately before completion: the completion affects zero rows', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A', past());
    reclaim(db, 'lease-B');

    const outcome = db.prepare(JOB_SQL.success).run('x', ID, TYPE, 'success', 1, '{}', 'now', 'now', 'lease-A');
    assert.equal(outcome.changes, 0);
    assert.equal(read(db).status, 'running');
    assert.equal(read(db).lease_token, 'lease-B');
  } finally { db.close(); }
});

test('two retries competing for one stale job: only one proceeds', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A', past());

    const first = reclaim(db, 'lease-R1');
    const second = reclaim(db, 'lease-R2');
    assert.equal(first.changes, 1);
    assert.equal(second.changes, 0, 'the loser must find a live lease');

    // The loser's batch is fenced out; the winner's commits.
    assert.equal(fencedBatch(db, 'lease-R2', [insertNews('content_R2', 'r2'), completeSuccess('lease-R2', {})]).committed, false);
    assert.equal(fencedBatch(db, 'lease-R1', [insertNews('content_R1', 'r1'), completeSuccess('lease-R1', { id: 'content_R1' })]).committed, true);

    assert.equal(newsRows(db).length, 1);
    assert.equal(newsRows(db)[0].id, 'content_R1');
    assert.equal(read(db).status, 'success');
  } finally { db.close(); }
});

test('a live lease passes the fence', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A', future());
    const outcome = fencedBatch(db, 'lease-A', [insertNews('content_A', 'a'), completeSuccess('lease-A', { id: 'content_A' })]);
    assert.equal(outcome.committed, true);
    assert.equal(newsRows(db).length, 1);
    assert.equal(read(db).status, 'success');
  } finally { db.close(); }
});

// ------------------------------------------------------------ contract tests

test('no mutation handler bypasses the fencing helper', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) files.push(next);
    }
  };
  await walk('src/server');

  const offenders = [];
  for (const file of files) {
    if (file === 'src/server/control-plane/job-store.ts') continue;
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    if (/env\.DB\.batch\(/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `mutation batches must go through fencedBatch:\n${offenders.join('\n')}`);
});

test('lease ownership is never recovered by commandId lookup', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) files.push(next);
    }
  };
  await walk('src/server');

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    assert.ok(!/currentLeaseToken|activeLeases|setLeaseToken|clearLeaseToken/.test(source), `${file}: a lease token must be carried in the execution context, never looked up by commandId`);
  }
});

test('the fence is the first statement of every fenced batch', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/control-plane/job-store.ts'), 'utf8');
  assert.match(source, /env\.DB\.batch\(\[fenceStatement\(execution\), \.\.\.statements\]/, 'the fence must precede every mutation in the batch');
  assert.match(source, /holds_lease/, 'the fence must be expressed as a constraint that fails');
});
