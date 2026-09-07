import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

const { evaluateExistingJob, evaluateClaim } = await loadServerModule('src/server/control-plane/replay.ts');
const workerSource = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

async function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  const files = (await readdir(path.join(repoRoot, 'migrations'))).filter((n) => n.endsWith('.sql')).sort();
  for (const name of files) db.exec(await readFile(path.join(repoRoot, 'migrations', name), 'utf8'));
  return db;
}

// The statements the Worker actually issues, kept in one place so this test
// exercises the same SQL shape the job store does.
const claim = (db, { claimId, commandId, commandType, digest }) => {
  db.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,command_digest,created_at,started_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`
  ).run(claimId, commandId, commandType, 'running', 1, digest, 'now', 'now');
  return db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(commandId);
};

const completeSuccess = (db, commandId, commandType, result) =>
  db.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,result_json,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET
       status=excluded.status,result_json=excluded.result_json,finished_at=excluded.finished_at`
  ).run('new-id', commandId, commandType, 'success', 1, JSON.stringify(result), 'now', 'now');

const completeFailure = (db, commandId, commandType) =>
  db.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,error_type,error_code,error_message,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET
       status=excluded.status,error_type=excluded.error_type,error_code=excluded.error_code,error_message=excluded.error_message,finished_at=excluded.finished_at`
  ).run('new-id', commandId, commandType, 'failed', 1, 'USER_CORRECTABLE', 'BOOM', 'failed', 'now', 'now');

// The defect this whole lifecycle rework began with: create_taxonomy_term's own
// job insert collided with the claim, so the command could never complete on a
// database where the claim had been written -- which is every database.
test('create_taxonomy_term completes from a fresh database', async () => {
  const db = await freshDatabase();
  try {
    const commandId = 'taxonomy-fresh-db-0001';
    const stored = claim(db, { claimId: 'claim-1', commandId, commandType: 'create_taxonomy_term', digest: DIGEST_A });
    assert.equal(stored.status, 'running');

    // The handler's own completion, through the shared statement shape.
    const outcome = completeSuccess(db, commandId, 'create_taxonomy_term', { termId: 'term_1', created: true });
    assert.equal(outcome.changes, 1, 'the completion must update the claimed row, not fail on its UNIQUE constraint');

    const rows = db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').all(commandId);
    assert.equal(rows.length, 1, 'exactly one job row may exist for the command');
    assert.equal(rows[0].status, 'success');
    assert.equal(rows[0].command_digest, DIGEST_A, 'completion must not disturb the identity binding');
    assert.equal(rows[0].command_type, 'create_taxonomy_term');

    // ...and it is replayable afterwards.
    const replay = evaluateExistingJob(commandId, 'create_taxonomy_term', DIGEST_A, rows[0]);
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(replay.result, { termId: 'term_1', created: true });
  } finally {
    db.close();
  }
});

test('every completion path leaves a terminal status', async () => {
  const db = await freshDatabase();
  try {
    for (const [commandId, finish] of [
      ['lifecycle-success-0001', () => completeSuccess(db, 'lifecycle-success-0001', 'create_news', { id: 'c1' })],
      ['lifecycle-failure-0001', () => completeFailure(db, 'lifecycle-failure-0001', 'create_news')]
    ]) {
      claim(db, { claimId: `claim-${commandId}`, commandId, commandType: 'create_news', digest: DIGEST_A });
      finish();
      const row = db.prepare('SELECT status,command_digest FROM jobs WHERE command_id=?').get(commandId);
      assert.ok(['success', 'failed'].includes(row.status), `${commandId} ended as "${row.status}"`);
      assert.equal(row.command_digest, DIGEST_A);
    }

    const stuck = db.prepare("SELECT command_id FROM jobs WHERE status='running'").all();
    assert.deepEqual(stuck, [], 'no claimed execution may remain running once it has finished');
  } finally {
    db.close();
  }
});

// The one legitimate `running` row: an execution actually in flight.
test('a deliberately concurrent execution is the only running row, and is refused a second time', async () => {
  const db = await freshDatabase();
  try {
    const commandId = 'lifecycle-concurrent-0001';
    claim(db, { claimId: 'claim-a', commandId, commandType: 'create_news', digest: DIGEST_A });

    const stored = db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(commandId);
    assert.equal(stored.status, 'running');
    assert.throws(() => evaluateExistingJob(commandId, 'create_news', DIGEST_A, stored), (e) => e.code === 'COMMAND_IN_PROGRESS');

    // A second claimant of the same command loses and is refused, rather than
    // executing alongside the first.
    const second = claim(db, { claimId: 'claim-b', commandId, commandType: 'create_news', digest: DIGEST_A });
    assert.equal(second.id, 'claim-a');
    assert.throws(() => evaluateClaim(commandId, 'create_news', DIGEST_A, second, 'claim-b'), (e) => e.code === 'COMMAND_IN_PROGRESS');
  } finally {
    db.close();
  }
});

test('a failed job is retryable by the same command and not by another', async () => {
  const db = await freshDatabase();
  try {
    const commandId = 'lifecycle-retry-0001';
    claim(db, { claimId: 'claim-a', commandId, commandType: 'create_news', digest: DIGEST_A });
    completeFailure(db, commandId, 'create_news');

    const stored = db.prepare('SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=?').get(commandId);
    assert.deepEqual(evaluateExistingJob(commandId, 'create_news', DIGEST_A, stored), { kind: 'proceed-after-failure' });
    assert.throws(() => evaluateExistingJob(commandId, 'create_timed_content', DIGEST_B, stored), (e) => e.code === 'COMMAND_ID_REUSED');

    const reopen = () => db.prepare("UPDATE jobs SET status='running' WHERE command_id=? AND command_digest=? AND status='failed'").run(commandId, DIGEST_A);
    assert.equal(reopen().changes, 1);
    assert.equal(reopen().changes, 0, 'only one retry may re-open a failed job');
  } finally {
    db.close();
  }
});

// Ordering is the guarantee: nothing that can refuse a command may run after
// the row has been set to running, or a refusal strands the id forever.
test('admission runs before the job is claimed', () => {
  const body = workerSource.slice(workerSource.indexOf('export async function executeCommand'));
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, `expected to find ${needle} in executeCommand`);
    return index;
  };

  const claimAt = at('claimCommand(');
  for (const admission of ['authorizeMutation(', 'assertCommandTargetsThisSite(', 'verifyPreflightBinding(', 'assertRuleVersion(', 'payloadSchema.parse(']) {
    assert.ok(at(admission) < claimAt, `${admission} must run before the job is claimed, or a refusal leaves a permanent running row`);
  }
  assert.ok(at('evaluateExistingJob(') < claimAt, 'the read-only idempotency check must precede the claim');
  assert.ok(claimAt < at('recordFailure('), 'failure recording belongs after the claim, in the handler scope');
});

test('the handler scope records every failure', () => {
  const body = workerSource.slice(workerSource.indexOf('// From here the job is `running`'));
  assert.match(body, /try \{/, 'the handler must run inside a try');
  assert.match(body, /catch \(e\) \{[\s\S]{0,400}recordFailure\(execution, e\)/, 'every handler exception must be recorded as terminal, under this attempt\'s own lease');
});

// The identity binding only holds if no handler writes its own job row.
test('no command handler writes to jobs directly', async () => {
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
    if (/(INSERT\s+INTO\s+jobs|UPDATE\s+jobs|DELETE\s+FROM\s+jobs)/i.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `job writes must go through control-plane/job-store.ts:\n${offenders.join('\n')}`);
});

// The completion SET clause is built from a constant, so scanning for a literal
// upsert is not enough: the constant itself must never name an identity column.
test('the shared completion clause cannot touch identity columns', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/control-plane/job-store.ts'), 'utf8');

  const completion = source.match(/const COMPLETION_SET = `([^`]+)`/);
  assert.ok(completion, 'job-store must define its completion columns in one place');
  for (const column of ['command_digest', 'command_type', 'command_id']) {
    assert.ok(!completion[1].includes(column), `a completion must not set ${column}: that would rebind the id to different work`);
  }

  // And no other upsert in the store may reintroduce one.
  for (const [, setClause] of source.matchAll(/DO UPDATE SET\s+([^`]+)`/g)) {
    const expanded = setClause.replace('${COMPLETION_SET}', completion[1]);
    assert.ok(!/command_digest\s*=/.test(expanded), 'no job upsert may set command_digest');
    assert.ok(!/command_type\s*=/.test(expanded), 'no job upsert may set command_type');
  }
});
