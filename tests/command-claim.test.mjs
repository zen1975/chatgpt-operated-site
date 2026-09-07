import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

const { evaluateClaim } = await loadServerModule('src/server/control-plane/replay.ts');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const ID = 'shared-command-id-001';

/**
 * A real jobs table, migrated exactly as an installation's would be, so the
 * claim is exercised against the actual UNIQUE constraint and the actual
 * ON CONFLICT DO NOTHING semantics rather than a hand-rolled imitation.
 */
async function jobsTable() {
  const db = new DatabaseSync(':memory:');
  const files = ['0001_initial.sql', '0006_job_command_digest.sql'];
  for (const name of files) {
    db.exec(await readFile(path.join(repoRoot, 'migrations', name), 'utf8'));
  }
  return db;
}

/** The Worker's claim, in SQL, first writer wins. */
function claim(db, { claimId, commandId, commandType, digest }) {
  db.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,command_digest,created_at,started_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`
  ).run(claimId, commandId, commandType, 'running', 1, digest, 'now', 'now');
  return db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(commandId);
}

const recordSuccess = (db, commandId, result) =>
  db.prepare("UPDATE jobs SET status='success', result_json=?, finished_at='now' WHERE command_id=?").run(JSON.stringify(result), commandId);

const recordFailure = (db, commandId) =>
  db.prepare("UPDATE jobs SET status='failed', error_code='BOOM', finished_at='now' WHERE command_id=?").run(commandId);

// Two different commands submitted concurrently under one id. Whichever writes
// first owns the id; the other must never take it over, never be answered from
// the winner's result, and never stop the winner from being replayed.
test('two different commands with one id: first writer wins', async () => {
  const db = await jobsTable();
  try {
    const a = claim(db, { claimId: 'claim-a', commandId: ID, commandType: 'create_news', digest: DIGEST_A });
    assert.equal(a.id, 'claim-a', 'A wrote the row, so A owns the binding');
    assert.deepEqual(evaluateClaim(ID, 'create_news', DIGEST_A, a, 'claim-a'), { kind: 'claimed' });

    // B arrives with a different command under the same id.
    const b = claim(db, { claimId: 'claim-b', commandId: ID, commandType: 'create_timed_content', digest: DIGEST_B });

    assert.equal(b.id, 'claim-a', 'B must not replace the row');
    assert.equal(b.command_digest, DIGEST_A, 'B must not overwrite A\'s digest');
    assert.equal(b.command_type, 'create_news', 'B must not overwrite A\'s command type');

    assert.throws(
      () => evaluateClaim(ID, 'create_timed_content', DIGEST_B, b, 'claim-b'),
      (error) => error.code === 'COMMAND_ID_REUSED',
      'B must be refused, not admitted'
    );

    // A completes. B still cannot be answered from A's result.
    recordSuccess(db, ID, { id: 'content_a' });
    const afterSuccess = db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(ID);

    assert.equal(afterSuccess.command_digest, DIGEST_A, 'recording success must not touch the identity binding');
    assert.equal(afterSuccess.command_type, 'create_news');

    assert.throws(() => evaluateClaim(ID, 'create_timed_content', DIGEST_B, afterSuccess), (error) => error.code === 'COMMAND_ID_REUSED', 'B must never replay A\'s result');

    // A remains replayable.
    const replay = evaluateClaim(ID, 'create_news', DIGEST_A, afterSuccess);
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(replay.result, { id: 'content_a' });

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE command_id=?').get(ID).n, 1, 'exactly one job may exist for the id');
  } finally {
    db.close();
  }
});

test('a second claimant of the same command waits rather than executing concurrently', async () => {
  const db = await jobsTable();
  try {
    claim(db, { claimId: 'claim-a', commandId: ID, commandType: 'create_news', digest: DIGEST_A });
    const second = claim(db, { claimId: 'claim-b', commandId: ID, commandType: 'create_news', digest: DIGEST_A });

    assert.equal(second.id, 'claim-a');
    assert.throws(
      () => evaluateClaim(ID, 'create_news', DIGEST_A, second, 'claim-b'),
      (error) => error.code === 'COMMAND_IN_PROGRESS' && error.retryable === true
    );
  } finally {
    db.close();
  }
});

// Permitted behaviour for a failed job: the same command may be retried, and
// the identity binding set by the first writer is untouched by that retry.
test('a failed job may be retried by the same command without weakening the claim', async () => {
  const db = await jobsTable();
  try {
    claim(db, { claimId: 'claim-a', commandId: ID, commandType: 'create_news', digest: DIGEST_A });
    recordFailure(db, ID);

    const stored = db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(ID);
    assert.equal(stored.command_digest, DIGEST_A, 'recording failure must not touch the identity binding');

    assert.deepEqual(evaluateClaim(ID, 'create_news', DIGEST_A, stored), { kind: 'retry-after-failure' });

    // A *different* command still cannot take the id over after a failure.
    assert.throws(() => evaluateClaim(ID, 'create_timed_content', DIGEST_B, stored), (error) => error.code === 'COMMAND_ID_REUSED');

    // The retry re-opens the row only while it is still failed, so two retries
    // cannot both start.
    const reopen = () => db.prepare("UPDATE jobs SET status='running' WHERE command_id=? AND command_digest=? AND status='failed'").run(ID, DIGEST_A);
    assert.equal(reopen().changes, 1);
    assert.equal(reopen().changes, 0, 'a second concurrent retry must not re-open an already running job');
  } finally {
    db.close();
  }
});

test('a legacy job with no digest cannot be claimed by any command', async () => {
  const db = await jobsTable();
  try {
    db.prepare("INSERT INTO jobs (id,command_id,command_type,status,attempt_count,created_at) VALUES ('legacy',?, 'create_news','success',1,'now')").run(ID);
    db.prepare("UPDATE jobs SET result_json=? WHERE command_id=?").run(JSON.stringify({ id: 'legacy_result' }), ID);

    const stored = db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(ID);
    assert.equal(stored.command_digest, null);
    assert.throws(() => evaluateClaim(ID, 'create_news', DIGEST_A, stored), (error) => error.code === 'COMMAND_DIGEST_UNVERIFIABLE');
  } finally {
    db.close();
  }
});

// The binding is only durable if no write path rewrites it. Enforced against
// the source so a future upsert cannot quietly reintroduce the problem.
test('no job upsert may overwrite the identity binding', async () => {
  const { readdir } = await import('node:fs/promises');
  const roots = ['src/server'];
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) files.push(next);
    }
  };
  for (const root of roots) await walk(root);

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    for (const [, setClause] of source.matchAll(/ON CONFLICT\(command_id\) DO UPDATE SET ([^`'"]+)/g)) {
      assert.ok(!/command_digest\s*=/.test(setClause), `${file}: a job upsert must never overwrite command_digest`);
      assert.ok(!/command_type\s*=/.test(setClause), `${file}: a job upsert must never overwrite command_type`);
    }
  }
});
