import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';

// A guarded UPDATE matching zero rows is not an error, so checking affected
// rows after the batch discovers the conflict only once everything else has
// committed. The version guard is therefore a fence: it fails, and D1 rolls the
// whole sequence back.
const { JOB_SQL, VERSION_GUARDS } = await loadServerModule('src/server/control-plane/job-store.ts');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ID = 'version-fence-0001';
const TYPE = 'replace_asset';
const SHA = 'd'.repeat(64);
const ASSET_ID = `asset_${SHA}_original`;
const R2_KEY = `assets/${SHA}.jpg`;
const future = () => new Date(Date.now() + 600_000).toISOString();

async function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  const files = (await readdir(path.join(repoRoot, 'migrations'))).filter((n) => n.endsWith('.sql')).sort();
  for (const name of files) db.exec(await readFile(path.join(repoRoot, 'migrations', name), 'utf8'));
  db.prepare(`INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('content_1', 'headline', 'Headline', '[]', 'published', 1, 'now', 'now', 'news');
  return db;
}

const claim = (db, leaseToken) => {
  db.prepare(JOB_SQL.claim).run(`claim-${leaseToken}`, ID, TYPE, 'running', 1, DIGEST, 'now', 'now', leaseToken, future());
};
const readJob = (db) => db.prepare(JOB_SQL.read).get(ID);

/** The version fence, built exactly as the implementation builds it. */
const versionFenceSql = (subject) => {
  const guard = VERSION_GUARDS[subject];
  return JOB_SQL.versionFence.replace('<GUARD>', `${guard.table} WHERE ${guard.predicate}`);
};

/**
 * A fenced batch as D1 runs one: lease fence, then version fences, then the
 * caller's statements, all in one transaction. Results are addressed by name.
 */
function fencedBatch(db, leaseToken, statements, guards = []) {
  const all = [
    { name: 'lease-fence', sql: JOB_SQL.fence, params: [ID, leaseToken, ID, leaseToken, 'now'] },
    ...guards.map((g) => ({ name: `version-fence:${g.subject}`, sql: versionFenceSql(g.subject), params: [ID, g.subject, g.expectedVersion, ...g.keys, 'now'] })),
    ...statements
  ];
  db.exec('BEGIN');
  try {
    const byName = new Map();
    for (const entry of all) byName.set(entry.name, db.prepare(entry.sql).run(...entry.params));
    db.exec('COMMIT');
    return { committed: true, changes: (name) => byName.get(name)?.changes };
  } catch (error) {
    db.exec('ROLLBACK');
    return { committed: false, error };
  }
}

/**
 * The registration statements a preparation hands back. The first registers the
 * asset the attachment will reference; any further ones stand in for extra
 * variants, so the guard can be shown to behave the same whatever the count.
 */
const intake = (count = 1) => Array.from({ length: count }, (_, index) => ({
  name: `intake-${index}`,
  sql: `INSERT INTO assets (id,r2_key,original_filename,mime_type,bytes,alt,variant,created_at,source_provider,sha256,logical_asset_id,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: index === 0
    ? [ASSET_ID, R2_KEY, 'a.jpg', 'image/jpeg', 10, '', 'original', 'now', 'google_drive', SHA, `logical_${SHA}`, 'validated']
    : [`asset_${SHA.slice(0, 63)}${index}_medium`, `${R2_KEY}.${index}`, 'a.jpg', 'image/jpeg', 10, '', 'medium', 'now', 'google_drive', `${SHA.slice(0, 63)}${index}`, `logical_${SHA}`, 'validated']
}));
const attach = { name: 'asset-attach', sql: `INSERT INTO content_assets (content_type,content_id,asset_id,role,position,created_at) VALUES (?,?,?,?,?,?)`, params: ['news', 'content_1', ASSET_ID, 'hero', 0, 'now'] };
const domainUpdate = (expected) => ({ name: 'domain-update', sql: `UPDATE news SET version=?,updated_at=? WHERE id=? AND content_type=? AND version=?`, params: [expected + 1, 'now', 'content_1', 'news', expected] });
const revision = { name: 'revision', sql: `INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`, params: ['rev_1', 'news', 'content_1', 'replace_asset', null, '{}', ID, 'now'] };
const success = (leaseToken) => ({ name: 'success', sql: JOB_SQL.success, params: ['new', ID, TYPE, 'success', 1, JSON.stringify({ ok: true }), 'now', 'now', leaseToken] });

const newsGuard = (expected) => ({ subject: 'news', expectedVersion: expected, keys: ['content_1', 'news', expected] });
const assets = (db) => db.prepare('SELECT id FROM assets').all();
const attachments = (db) => db.prepare('SELECT asset_id FROM content_assets').all();
const revisions = (db) => db.prepare('SELECT id FROM content_revisions').all();

// ------------------------------------------- first-time reference-backed asset

test('a first-time reference-backed replace_asset succeeds', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A');
    // The asset does not exist in D1 yet: it is registered by this very batch.
    assert.deepEqual(assets(db), []);

    const outcome = fencedBatch(db, 'lease-A', [...intake(1), domainUpdate(1), attach, revision, success('lease-A')], [newsGuard(1)]);

    assert.equal(outcome.committed, true, 'a first-time reference-backed replacement must succeed');
    assert.equal(assets(db).length, 1, 'the asset is registered by the same batch');
    assert.equal(attachments(db).length, 1, 'and attached');
    assert.equal(readJob(db).status, 'success');
  } finally { db.close(); }
});

test('registered asset metadata points at an existing content-addressed object', async () => {
  const db = await freshDatabase();
  const objects = new Set([R2_KEY]);   // written during preparation
  try {
    claim(db, 'lease-A');
    fencedBatch(db, 'lease-A', [...intake(1), domainUpdate(1), attach, revision, success('lease-A')], [newsGuard(1)]);

    for (const row of db.prepare('SELECT r2_key FROM assets').all()) {
      assert.ok(objects.has(row.r2_key), 'every committed asset row must point at an object that exists');
    }
  } finally { db.close(); }
});

// ------------------------------------------------------- version interleaving

// Another execution advances the version between preparation and the final
// batch. Everything must roll back -- not just the update.
test('a version advanced after preparation rolls the whole batch back', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A');

    // Preparation happened while the content was at version 1.
    const prepared = intake(1);

    // Another execution advances it to 2.
    db.prepare('UPDATE news SET version=2 WHERE id=?').run('content_1');

    const outcome = fencedBatch(db, 'lease-A', [...prepared, domainUpdate(1), attach, revision, success('lease-A')], [newsGuard(1)]);

    assert.equal(outcome.committed, false, 'the batch must fail rather than commit around a stale guard');
    assert.match(String(outcome.error), /matches|command_version_fence/);
    assert.deepEqual(assets(db), [], 'no asset registration');
    assert.deepEqual(attachments(db), [], 'no attachment');
    assert.deepEqual(revisions(db), [], 'no revision');
    assert.notEqual(readJob(db).status, 'success', 'and no success');
  } finally { db.close(); }
});

test('a conflicted job cannot be looked up as successful', async () => {
  const db = await freshDatabase();
  try {
    claim(db, 'lease-A');
    db.prepare('UPDATE news SET version=2 WHERE id=?').run('content_1');
    fencedBatch(db, 'lease-A', [...intake(1), domainUpdate(1), attach, revision, success('lease-A')], [newsGuard(1)]);

    const job = readJob(db);
    assert.equal(job.status, 'running');
    assert.equal(job.result_json, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='success'").get().n, 0);
  } finally { db.close(); }
});

// The guard must not depend on how many statements precede it.
test('the guard behaves identically with zero, one and several intake statements', async () => {
  for (const count of [0, 1, 3]) {
    const db = await freshDatabase();
    try {
      claim(db, 'lease-A');
      db.prepare('UPDATE news SET version=2 WHERE id=?').run('content_1');

      const conflicted = fencedBatch(db, 'lease-A', [...intake(count), domainUpdate(1), ...(count ? [attach] : []), revision, success('lease-A')], [newsGuard(1)]);
      assert.equal(conflicted.committed, false, `${count} intake statements: a stale guard must abort`);
      assert.deepEqual(assets(db), [], `${count} intake statements: nothing may commit`);
    } finally { db.close(); }

    const clean = await freshDatabase();
    try {
      claim(clean, 'lease-A');
      const ok = fencedBatch(clean, 'lease-A', [...intake(count), domainUpdate(1), ...(count ? [attach] : []), revision, success('lease-A')], [newsGuard(1)]);
      assert.equal(ok.committed, true, `${count} intake statements: a matching guard must commit`);
      assert.equal(ok.changes('success'), 1, `${count} intake statements: the success result is found by name, not position`);
      assert.equal(ok.changes('domain-update'), 1, `${count} intake statements: the guarded update is found by name`);
    } finally { clean.close(); }
  }
});

// ------------------------------------------------------------ contract tests

test('no batch result is read by numeric index', async () => {
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
    for (const pattern of [/\bbatch\s*\[\s*\d/, /\bresults\s*\[\s*\d/, /\bbatch\s*\[\s*\w+\.length/, /\bresults\s*\[\s*\w+\.length/]) {
      if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `batch results must be addressed by name; a numeric index silently means something else as soon as the batch changes length:\n${offenders.join('\n')}`);
});

test('every version-guarded mutation path uses the shared fence', async () => {
  const paths = {
    'src/server/commands.ts': 'news',
    'src/server/product/mutations.ts': 'products',
    'src/server/page-composition/mutations.ts': 'pages'
  };

  for (const [file, subject] of Object.entries(paths)) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    assert.ok(source.includes(`versionGuards: [{ subject: '${subject}'`), `${file} must guard its ${subject} mutation with the shared fence`);
  }

  // The page path also guards the section it mutates.
  const page = await readFile(path.join(repoRoot, 'src/server/page-composition/mutations.ts'), 'utf8');
  assert.match(page, /subject: 'page_sections'/, 'a section mutation must guard the section version too');

  // Every registered guard subject is reachable from a mutation path.
  const allSources = (await Promise.all(Object.keys(paths).map((file) => readFile(path.join(repoRoot, file), 'utf8')))).join('\n');
  for (const subject of Object.keys(VERSION_GUARDS)) {
    assert.ok(allSources.includes(`subject: '${subject}'`), `${subject} is a registered version guard but no mutation path uses it`);
  }
});

test('the version fence table and predicate come from a closed map', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/control-plane/job-store.ts'), 'utf8');
  assert.match(source, /JOB_SQL\.versionFence\.replace\('<GUARD>', `\$\{definition\.table\} WHERE \$\{definition\.predicate\}`\)/, 'the guard must be substituted from the map, never from a payload');
  assert.match(source, /if \(guard\.keys\.length !== definition\.arity\)/, 'the key count must match the predicate');
  for (const [subject, guard] of Object.entries(VERSION_GUARDS)) {
    assert.equal(typeof guard.table, 'string');
    assert.equal(guard.predicate.split('?').length - 1, guard.arity, `${subject}: arity must match its placeholders`);
  }
});

// ------------------------------- product and page first-time reference paths

test('the product and page paths look up an existing asset only when one was named', async () => {
  const commands = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');
  const product = await readFile(path.join(repoRoot, 'src/server/product/mutations.ts'), 'utf8');
  const page = await readFile(path.join(repoRoot, 'src/server/page-composition/mutations.ts'), 'utf8');

  // content: the D1 existence check sits inside the canonical-assetId branch,
  // never on the prepared-reference branch.
  const replaceAsset = commands.slice(commands.indexOf("if (cmd.command === 'replace_asset')"), commands.indexOf("if (cmd.command === 'create_timed_content')"));
  const guardedBranch = replaceAsset.slice(replaceAsset.indexOf('if (p.assetId) {'), replaceAsset.indexOf('} else {'));
  assert.match(guardedBranch, /ASSET_NOT_FOUND/, 'a named assetId must still be verified against D1');
  const preparedBranch = replaceAsset.slice(replaceAsset.indexOf('} else {'));
  assert.ok(!/ASSET_NOT_FOUND/.test(preparedBranch), 'a prepared reference must not be looked up before its own batch registers it');
  assert.match(preparedBranch, /prepared\.result\.assetId/, 'the prepared assetId is used directly');
  assert.match(preparedBranch, /prepared\.statements/, 'and its registration travels into the batch');

  for (const [label, source] of [['product', product], ['page', page]]) {
    assert.match(source, /resolveAssetReference\(/, `${label} resolves provider references`);
    assert.match(source, /\.\.\.intakeStatements/, `${label} must carry the registration into its own batch`);
  }

  // The page path only asserts asset availability when the caller named one.
  const pageLookup = page.slice(page.indexOf('const assetReference = payload.reference;'));
  const availability = pageLookup.indexOf('PAGE_ASSET_UNUSABLE');
  const prepared = pageLookup.indexOf('resolved.result.assetId');
  assert.ok(prepared !== -1 && availability !== -1);
  assert.match(pageLookup.slice(0, availability), /intakeStatements = resolved\.statements/, 'the page path prepares before it validates');
});

test('a first-time reference-backed product mutation commits registration and attachment together', async () => {
  const db = await freshDatabase();
  try {
    db.prepare(`INSERT INTO products (id,slug,title,description,category,price_currency,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('product_1', 'widget', 'Widget', '', '', 'JPY', 'draft', 1, 'now', 'now');
    claim(db, 'lease-A');

    const outcome = fencedBatch(db, 'lease-A', [
      ...intake(1),
      { name: 'mutation-0', sql: 'UPDATE products SET version=?,updated_at=? WHERE id=? AND version=?', params: [2, 'now', 'product_1', 1] },
      { name: 'mutation-1', sql: 'INSERT INTO product_assets (product_id,asset_id,role,position,created_at) VALUES (?,?,?,?,?)', params: ['product_1', ASSET_ID, 'primary', 0, 'now'] },
      revision,
      success('lease-A')
    ], [{ subject: 'products', expectedVersion: 1, keys: ['product_1', 1] }]);

    assert.equal(outcome.committed, true, 'the asset is registered by the same batch that attaches it');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM product_assets').get().n, 1);
    assert.equal(readJob(db).status, 'success');
  } finally { db.close(); }
});

test('a first-time reference-backed page section mutation commits registration and section change together', async () => {
  const db = await freshDatabase();
  try {
    db.prepare(`INSERT INTO pages (id,slug,title,page_type,template_profile,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('page_1', 'about', 'About', 'standard', 'standard', 'published', 1, 'now', 'now');
    db.prepare(`INSERT INTO page_sections (id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('section_1', 'page_1', 'hero', 0, 'default', '{}', 'published', 1, 'now', 'now');
    claim(db, 'lease-A');

    const outcome = fencedBatch(db, 'lease-A', [
      ...intake(1),
      { name: 'mutation-0', sql: 'UPDATE pages SET version=?,updated_at=? WHERE id=? AND version=?', params: [2, 'now', 'page_1', 1] },
      { name: 'mutation-1', sql: 'UPDATE page_sections SET props_json=?,version=?,updated_at=? WHERE id=? AND page_id=? AND version=?', params: ['{}', 2, 'now', 'section_1', 'page_1', 1] },
      revision,
      success('lease-A')
    ], [{ subject: 'pages', expectedVersion: 1, keys: ['page_1', 1] }, { subject: 'page_sections', expectedVersion: 1, keys: ['section_1', 1] }]);

    assert.equal(outcome.committed, true);
    assert.equal(db.prepare('SELECT version FROM page_sections WHERE id=?').get('section_1').version, 2);
    assert.equal(readJob(db).status, 'success');
  } finally { db.close(); }
});

test('an advanced section version aborts the batch even when the page version still matches', async () => {
  const db = await freshDatabase();
  try {
    db.prepare(`INSERT INTO pages (id,slug,title,page_type,template_profile,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('page_1', 'about', 'About', 'standard', 'standard', 'published', 1, 'now', 'now');
    db.prepare(`INSERT INTO page_sections (id,page_id,section_type,position,variant,props_json,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('section_1', 'page_1', 'hero', 0, 'default', '{}', 'published', 5, 'now', 'now');
    claim(db, 'lease-A');

    const outcome = fencedBatch(db, 'lease-A', [
      ...intake(1),
      { name: 'mutation-0', sql: 'UPDATE pages SET version=? WHERE id=? AND version=?', params: [2, 'page_1', 1] },
      success('lease-A')
    ], [{ subject: 'pages', expectedVersion: 1, keys: ['page_1', 1] }, { subject: 'page_sections', expectedVersion: 1, keys: ['section_1', 1] }]);

    assert.equal(outcome.committed, false, 'a stale section guard must abort the batch');
    assert.deepEqual(assets(db), []);
    assert.notEqual(readJob(db).status, 'success');
  } finally { db.close(); }
});

// The tests above run the fence SQL directly, which proves the SQL works but
// not that the implementation still emits it. These hold the implementation.
test('fencedBatch emits a version fence for every supplied guard', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/control-plane/job-store.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function fencedBatch'), source.indexOf('const isLeaseFenceViolation'));

  assert.match(body, /for \(const guard of options\.versionGuards \?\? \[\]\) \{/, 'every supplied guard must produce a fence');
  assert.match(body, /prefix\.push\(named\(`version-fence:\$\{guard\.subject\}`, versionFenceStatement\(execution, guard, now\)\)\)/);
  assert.match(body, /isVersionFenceViolation\(error\)/, 'a version fence violation must be translated into a conflict');
  assert.ok(!/versionGuards\?\.\[0\]|versionGuards\[0\]/.test(body), 'guards must not be handled positionally');
});

test('no code casts named results back into an array', async () => {
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
    // NamedResults deliberately has no index signature, so reaching a result by
    // position requires casting around the type. That is the loophole.
    if (/as unknown as unknown\[\]|as unknown as any\[\]|as D1Result\[\]/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `batch results must stay name-addressed; casting them to an array reopens positional access:\n${offenders.join('\n')}`);
});

test('the version guard is applied by the batch, not checked afterwards', async () => {
  for (const file of ['src/server/commands.ts', 'src/server/product/mutations.ts', 'src/server/page-composition/mutations.ts']) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    // The old shape: run the batch, then decide the version was stale from a
    // row count. By then the rest of the batch has already committed.
    assert.ok(
      !/changes\s*!==\s*1\s*\)\s*throw new CommandError\('CONFLICT'/.test(source),
      `${file}: a version conflict must abort the batch, not be discovered from affected rows afterwards`
    );
  }
});
