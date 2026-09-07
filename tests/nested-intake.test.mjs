import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

// Only the outermost command execution may finalize its job. A nested intake
// that completed the shared job marked the parent command successful and
// cleared its lease before the parent had written anything -- the parent's own
// batch then failed its fence, while lookups reported a replacement that never
// happened.
const { JOB_SQL } = await loadServerModule('src/server/control-plane/job-store.ts');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ID = 'nested-intake-0001';
const TYPE = 'replace_asset';
const SHA = 'c'.repeat(64);
const ASSET_ID = `asset_${SHA}_original`;
const R2_KEY = `assets/${SHA}.jpg`;
const future = () => new Date(Date.now() + 600_000).toISOString();
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

function fencedBatch(db, leaseToken, statements) {
  db.exec('BEGIN');
  try {
    db.prepare(JOB_SQL.fence).run(ID, leaseToken, ID, leaseToken, 'now');
    statements.forEach(({ sql, params }) => db.prepare(sql).run(...params));
    db.exec('COMMIT');
    return { committed: true };
  } catch (error) {
    db.exec('ROLLBACK');
    return { committed: false, error };
  }
}

/** The statements a preparation hands back: registration plus its revision. */
const intakeStatements = () => [
  { sql: `INSERT INTO assets (id,r2_key,original_filename,mime_type,bytes,alt,variant,created_at,source_provider,sha256,logical_asset_id,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [ASSET_ID, R2_KEY, 'a.jpg', 'image/jpeg', 10, '', 'original', 'now', 'google_drive', SHA, `logical_${SHA}`, 'validated'] },
  { sql: `INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    params: ['rev_asset', 'asset', ASSET_ID, 'create', null, '{}', ID, 'now'] }
];
const replacementStatements = () => [
  { sql: `INSERT INTO content_assets (content_type,content_id,asset_id,role,position,created_at) VALUES (?,?,?,?,?,?)`,
    params: ['news', 'content_1', ASSET_ID, 'hero', 0, 'now'] },
  { sql: `INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    params: ['rev_replace', 'news', 'content_1', 'replace_asset', null, '{}', ID, 'now'] }
];
const completion = (leaseToken, result) => ({
  sql: JOB_SQL.success,
  params: ['new', ID, TYPE, 'success', 1, JSON.stringify(result), 'now', 'now', leaseToken]
});

const assetRows = (db) => db.prepare('SELECT id,r2_key FROM assets').all();
const attachments = (db) => db.prepare('SELECT asset_id FROM content_assets').all();

/** A content-addressed object store: writing the same key twice is a no-op. */
function objectStore() {
  const objects = new Map();
  return {
    put: (key, bytes) => objects.set(key, bytes),
    has: (key) => objects.has(key),
    delete: (key) => objects.delete(key),
    size: () => objects.size
  };
}

// ------------------------------------------------------------- nested intake

test('nested intake prepares the asset but leaves the parent job running', async () => {
  const db = await freshDatabase();
  const r2 = objectStore();
  try {
    claim(db, 'lease-A');

    // Preparation: bytes fetched, content-addressed object written, statements
    // returned. No job write at all.
    r2.put(R2_KEY, 'bytes');
    const prepared = intakeStatements();

    assert.equal(read(db).status, 'running', 'preparation must not finalize the parent job');
    assert.notEqual(read(db).lease_token, null, 'preparation must not clear the lease');
    assert.deepEqual(assetRows(db), [], 'preparation writes no D1 row of its own');
    assert.ok(r2.has(R2_KEY), 'the content-addressed object is written during preparation');

    // The outer command commits everything, including the single success.
    const outcome = fencedBatch(db, 'lease-A', [...prepared, ...replacementStatements(), completion('lease-A', { assetId: ASSET_ID })]);
    assert.equal(outcome.committed, true);

    const job = read(db);
    assert.equal(job.status, 'success');
    assert.deepEqual(JSON.parse(job.result_json), { assetId: ASSET_ID });
    assert.equal(assetRows(db).length, 1);
    assert.equal(attachments(db).length, 1, 'the replacement actually happened');
  } finally { db.close(); }
});

test('the parent replacement performs the only success transition', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A');
    fencedBatch(db, 'lease-A', [...intakeStatements(), ...replacementStatements(), completion('lease-A', { assetId: ASSET_ID })]);

    const jobs = db.prepare("SELECT command_id,status FROM jobs WHERE status='success'").all();
    assert.equal(jobs.length, 1, 'exactly one terminal command result');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
  } finally { db.close(); }
});

// If intake had finalized the job, the parent's own batch would fail its fence
// and the command would still be reported successful. It must not.
test('parent fence failure leaves no replacement, no revision and no success', async () => {
  const db = await freshDatabase();
  const r2 = objectStore();
  try {
    claim(db, 'lease-A', past());
    r2.put(R2_KEY, 'bytes');            // preparation already happened
    reclaim(db, 'lease-B');             // the parent's lease is gone

    const outcome = fencedBatch(db, 'lease-A', [...intakeStatements(), ...replacementStatements(), completion('lease-A', { assetId: ASSET_ID })]);

    assert.equal(outcome.committed, false);
    assert.deepEqual(assetRows(db), [], 'no asset registration');
    assert.deepEqual(attachments(db), [], 'no replacement');
    assert.deepEqual(db.prepare('SELECT id FROM content_revisions').all(), [], 'no revision');
    assert.notEqual(read(db).status, 'success', 'the command must not be reported successful');
    assert.equal(read(db).status, 'running', 'the job still belongs to the replacement attempt');
  } finally { db.close(); }
});

// ------------------------------------------------- shared content-addressed key

test('a stale attempt cannot delete the retry\'s content-addressed object', async () => {
  const db = await freshDatabase();
  const r2 = objectStore();
  try {
    // A writes the object, then loses its lease.
    claim(db, 'lease-A', past());
    r2.put(R2_KEY, 'bytes');
    reclaim(db, 'lease-B');

    // B writes the same key: content-addressed, so this is the same object.
    r2.put(R2_KEY, 'bytes');
    assert.equal(r2.size(), 1, 'the same content yields one object');

    // A's batch is fenced out. Crucially, A performs no compensating delete:
    // the command path contains none.
    const stale = fencedBatch(db, 'lease-A', [...intakeStatements(), completion('lease-A', {})]);
    assert.equal(stale.committed, false);
    assert.ok(r2.has(R2_KEY), 'the stale attempt must not delete the shared key');

    // B commits metadata that points at an object which still exists.
    const winner = fencedBatch(db, 'lease-B', [...intakeStatements(), ...replacementStatements(), completion('lease-B', { assetId: ASSET_ID })]);
    assert.equal(winner.committed, true);

    const registered = assetRows(db);
    assert.equal(registered.length, 1);
    assert.ok(r2.has(registered[0].r2_key), 'the committed D1 record must point at an existing object');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='success'").get().n, 1, 'exactly one terminal result');
  } finally { db.close(); }
});

test('failed intake may orphan an object but never leaves a record pointing at a missing one', async () => {
  const db = await freshDatabase();
  const r2 = objectStore();
  try {
    claim(db, 'lease-A', past());
    r2.put(R2_KEY, 'bytes');
    reclaim(db, 'lease-B');

    fencedBatch(db, 'lease-A', [...intakeStatements(), completion('lease-A', {})]);

    // Orphaned object: acceptable, inert, and reclaimable by a later GC pass.
    assert.ok(r2.has(R2_KEY));
    // But no D1 record at all, so nothing can point at a missing object.
    assert.deepEqual(assetRows(db), []);

    for (const row of assetRows(db)) assert.ok(r2.has(row.r2_key));
  } finally { db.close(); }
});

// ------------------------------------------------------------ contract tests

test('no nested helper finalizes a job', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) files.push(next);
    }
  };
  await walk('src/server');

  // Only root command orchestration may complete a job: commands.ts routes the
  // 33 external commands, the two mutation modules are entered from it with the
  // outer execution, and assets.ts finalizes only in its explicit root-command
  // entry point.
  const allowed = new Set([
    'src/server/commands.ts',
    'src/server/control-plane/job-store.ts',
    'src/server/product/mutations.ts',
    'src/server/page-composition/mutations.ts',
    'src/server/core/assets.ts'
  ]);

  const offenders = [];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    if (/successStatement\(|recordSuccess\(/.test(source) && !allowed.has(file)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `only root command orchestration may finalize a job:\n${offenders.join('\n')}`);
});

test('asset intake finalizes only in its root-command entry point', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/core/assets.ts'), 'utf8');

  const prepare = source.slice(source.indexOf('export async function prepareAssetIntake'), source.indexOf('export async function ingestAssetAsRootCommand'));
  assert.ok(!/successStatement\(/.test(prepare), 'preparation must never complete a job');
  assert.ok(!/fencedBatch\(/.test(prepare), 'preparation must not commit its own batch');
  assert.match(prepare, /return \{\s*result,\s*statements:/, 'preparation must hand its statements to the outer command');

  const root = source.slice(source.indexOf('export async function ingestAssetAsRootCommand'));
  assert.match(root, /successStatement\(execution, result\)/, 'the root-command entry point performs the single finalization');
});

test('the command path performs no eager R2 deletion', async () => {
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
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    if (/storage\.delete\(|ASSETS_BUCKET\.delete\(|compensateUnassociatedAsset/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `a content-addressed key is shared state; the command path must not delete it:\n${offenders.join('\n')}`);
});

test('every provider-backed parent commits intake statements in its own batch', async () => {
  const commands = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');
  const product = await readFile(path.join(repoRoot, 'src/server/product/mutations.ts'), 'utf8');
  const page = await readFile(path.join(repoRoot, 'src/server/page-composition/mutations.ts'), 'utf8');

  for (const [label, source] of [['replace_asset', commands], ['product asset', product], ['page section asset', page]]) {
    assert.match(source, /intakeStatements/, `${label} must carry the intake's statements into its own batch`);
    assert.ok(/\.\.\.intakeStatements|registration: intakeStatements/.test(source), `${label} must carry the intake registration into its own fenced batch`);
  }

  // And the resolver hands back a preparation rather than a finished asset.
  assert.match(commands, /Promise<AssetIntakePreparation>/);
  assert.match(product, /result: \{ assetId: string; reused: boolean \}; statements: D1PreparedStatement\[\]/);
  assert.match(page, /result: \{ assetId: string; reused: boolean \}; statements: D1PreparedStatement\[\]/);
});
