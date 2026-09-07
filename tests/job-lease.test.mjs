import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

const { evaluateExistingJob, leaseIsLive } = await loadServerModule('src/server/control-plane/replay.ts');
// The statements the implementation actually issues. Retyping them here would
// prove only that the test agrees with itself.
const { JOB_SQL } = await loadServerModule('src/server/control-plane/job-store.ts');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const ID = 'lease-command-0001';
const TYPE = 'create_news';

const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString();

async function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  const files = (await readdir(path.join(repoRoot, 'migrations'))).filter((n) => n.endsWith('.sql')).sort();
  for (const name of files) db.exec(await readFile(path.join(repoRoot, 'migrations', name), 'utf8'));
  return db;
}

// The exact statements the job store issues, so this exercises the real SQL.
const claim = (db, { claimId, commandId = ID, commandType = TYPE, digest = DIGEST_A, leaseToken, expires = future() }) => {
  db.prepare(JOB_SQL.claim).run(claimId, commandId, commandType, 'running', 1, digest, 'now', 'now', leaseToken, expires);
  return read(db, commandId);
};

const read = (db, commandId = ID) => db.prepare(JOB_SQL.read).get(commandId);

const reclaim = (db, { commandId = ID, commandType = TYPE, digest = DIGEST_A, leaseToken }) =>
  db.prepare(JOB_SQL.reclaimExpired).run('now', leaseToken, future(), commandId, digest, commandType, new Date().toISOString());

const completeSuccess = (db, { commandId = ID, commandType = TYPE, leaseToken, result }) =>
  db.prepare(JOB_SQL.success).run('new', commandId, commandType, 'success', 1, JSON.stringify(result), 'now', 'now', leaseToken);

test('an unexpired lease means the command is in progress', async () => {
  const db = await freshDatabase();
  try {
    const stored = claim(db, { claimId: 'c1', leaseToken: 'lease-1', expires: future() });
    assert.ok(leaseIsLive(stored));
    assert.throws(() => evaluateExistingJob(ID, TYPE, DIGEST_A, stored), (e) => e.code === 'COMMAND_IN_PROGRESS');
  } finally { db.close(); }
});

test('an expired lease is reclaimable by the same command', async () => {
  const db = await freshDatabase();
  try {
    const stored = claim(db, { claimId: 'c1', leaseToken: 'lease-1', expires: past() });
    assert.equal(leaseIsLive(stored), false);
    assert.deepEqual(evaluateExistingJob(ID, TYPE, DIGEST_A, stored), { kind: 'reclaim-expired-lease' });

    assert.equal(reclaim(db, { leaseToken: 'lease-2' }).changes, 1);
    assert.equal(read(db).lease_token, 'lease-2');
  } finally { db.close(); }
});

// A stale lease must never become a way to rebind an id to different work.
test('a different command can never reclaim, however old the lease', async () => {
  const db = await freshDatabase();
  try {
    const stored = claim(db, { claimId: 'c1', leaseToken: 'lease-1', expires: past(24 * 60 * 60 * 1000) });

    assert.throws(() => evaluateExistingJob(ID, 'create_timed_content', DIGEST_B, stored), (e) => e.code === 'COMMAND_ID_REUSED');
    assert.throws(() => evaluateExistingJob(ID, TYPE, DIGEST_B, stored), (e) => e.code === 'COMMAND_ID_REUSED');

    assert.equal(reclaim(db, { digest: DIGEST_B, leaseToken: 'lease-x' }).changes, 0, 'a different digest must not reclaim');
    assert.equal(reclaim(db, { commandType: 'create_timed_content', leaseToken: 'lease-x' }).changes, 0, 'a different type must not reclaim');
    assert.equal(read(db).lease_token, 'lease-1', 'the original lease must be untouched');
  } finally { db.close(); }
});

test('only one of two racing reclaimers wins', async () => {
  const db = await freshDatabase();
  try {
    claim(db, { claimId: 'c1', leaseToken: 'lease-1', expires: past() });
    assert.equal(reclaim(db, { leaseToken: 'lease-A' }).changes, 1);
    assert.equal(reclaim(db, { leaseToken: 'lease-B' }).changes, 0, 'the second reclaimer must find a live lease');
    assert.equal(read(db).lease_token, 'lease-A');
  } finally { db.close(); }
});

// The core safety property: a superseded attempt cannot write its result over
// the attempt that replaced it.
test('a superseded attempt cannot complete', async () => {
  const db = await freshDatabase();
  try {
    claim(db, { claimId: 'c1', leaseToken: 'lease-old', expires: past() });
    reclaim(db, { leaseToken: 'lease-new' });

    assert.equal(completeSuccess(db, { leaseToken: 'lease-old', result: { id: 'stale' } }).changes, 0, 'the superseded attempt must be refused');
    assert.equal(read(db).status, 'running', 'and must not have changed the row');

    assert.equal(completeSuccess(db, { leaseToken: 'lease-new', result: { id: 'fresh' } }).changes, 1);
    const row = read(db);
    assert.equal(row.status, 'success');
    assert.deepEqual(JSON.parse(row.result_json), { id: 'fresh' });
    assert.equal(row.lease_token, null, 'a completed job holds no lease');
  } finally { db.close(); }
});

test('a completed job is replayed, not reclaimed', async () => {
  const db = await freshDatabase();
  try {
    claim(db, { claimId: 'c1', leaseToken: 'lease-1', expires: past() });
    completeSuccess(db, { leaseToken: 'lease-1', result: { id: 'done' } });

    const stored = read(db);
    const outcome = evaluateExistingJob(ID, TYPE, DIGEST_A, stored);
    assert.equal(outcome.kind, 'replay');
    assert.deepEqual(outcome.result, { id: 'done' });
  } finally { db.close(); }
});

test('the lease duration exceeds the supported attempt bound', async () => {
  const { LEASE_DURATION_MS, MAX_ATTEMPT_DURATION_MS } = await loadServerModule('src/server/control-plane/job-store.ts');
  assert.ok(LEASE_DURATION_MS > MAX_ATTEMPT_DURATION_MS, 'a live attempt must never outlive its lease');
  assert.ok(LEASE_DURATION_MS >= 10 * 60 * 1000, 'the lease must comfortably exceed any single Worker invocation');
});

test('a job with no recorded lease is never reclaimed blindly', async () => {
  const db = await freshDatabase();
  try {
    db.prepare(
      `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,command_digest,created_at) VALUES (?,?,?,?,?,?,?)`
    ).run('legacy', ID, TYPE, 'running', 1, DIGEST_A, 'now');

    const stored = read(db);
    assert.equal(stored.lease_expires_at, null);
    assert.ok(leaseIsLive(stored), 'a row with no lease must be treated as live rather than stolen');
    assert.throws(() => evaluateExistingJob(ID, TYPE, DIGEST_A, stored), (e) => e.code === 'COMMAND_IN_PROGRESS');
    assert.equal(reclaim(db, { leaseToken: 'lease-x' }).changes, 0);
  } finally { db.close(); }
});
