import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';

const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;
import { resolveCommandFile, runDispatch, DispatchError } from '../scripts/dispatch-command.mjs';

const run = promisify(execFile);

// resolveCommandFile requires git to confirm a file is committed, and fails
// closed without it. The Docker image ships no git, so these run wherever git
// is available and are skipped rather than weakened where it is not.
const gitAvailable = await run('git', ['rev-parse', '--git-dir'], { cwd: repoRoot }).then(() => true).catch(() => false);
const withGit = { skip: gitAvailable ? false : 'git is unavailable; command_file resolution fails closed here' };

const TRACKED = 'examples/commands/create-news.json';
const SECRET = 'PRIVATE-CONTENT-THAT-MUST-NEVER-BE-READ-OR-PRINTED';

let scratch;
test.before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'dispatch-source-'));
  await writeFile(path.join(scratch, 'outside.json'), JSON.stringify({ marker: SECRET }), 'utf8');
});
test.after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('a committed repository file resolves to its blob', withGit, async () => {
  const resolved = await resolveCommandFile(TRACKED);
  assert.equal(resolved.relativePath, TRACKED);
  assert.match(resolved.blobSha, /^[0-9a-f]{40,64}$/);
  assert.equal(JSON.parse(resolved.contents).command, 'create_news');
});

test('an absolute path is refused', withGit, async () => {
  await assert.rejects(
    () => resolveCommandFile(path.join(scratch, 'outside.json')),
    (e) => e instanceof DispatchError && e.code === 'COMMAND_FILE_ABSOLUTE'
  );
});

test('a traversal path is refused', withGit, async () => {
  await assert.rejects(
    () => resolveCommandFile('../../etc/hosts'),
    (e) => e.code === 'COMMAND_FILE_TRAVERSAL'
  );
  await assert.rejects(
    () => resolveCommandFile('examples/../../outside.json'),
    (e) => e.code === 'COMMAND_FILE_TRAVERSAL'
  );
});

// A symlink is the case a naive string check misses: the path looks
// repository-relative and contains no "..".
// An uncommitted symlink is not in the HEAD tree at all, so it is refused as
// untracked -- the blob is never resolved and the target is never opened.
test('a symlink escaping the repository is refused', withGit, async () => {
  const link = path.join(repoRoot, 'escape-probe.json');
  await rm(link, { force: true });
  await symlink(path.join(scratch, 'outside.json'), link);
  try {
    await assert.rejects(
      () => resolveCommandFile('escape-probe.json'),
      (e) => e.code === 'COMMAND_FILE_NOT_TRACKED'
    );
  } finally {
    await rm(link, { force: true });
  }
});

// A committed symlink is in the tree, with mode 120000. Following it would read
// whatever it points at, so the mode is checked rather than assumed.
test('a committed symlink is refused by its tree mode', withGit, async () => {
  const gitImpl = async (_bin, args) => {
    if (args[0] === 'ls-tree') return { stdout: `120000 blob ${'a'.repeat(40)}\tlink.json\0` };
    throw new Error('cat-file must not be reached for a symlink');
  };
  await assert.rejects(() => resolveCommandFile('link.json', { gitImpl }), (e) => e.code === 'COMMAND_FILE_SYMLINK');
});

test('a directory is refused', withGit, async () => {
  await assert.rejects(() => resolveCommandFile('examples/commands'), (e) => e.code === 'COMMAND_FILE_NOT_A_FILE');
});

test('a submodule entry is refused', async () => {
  const gitImpl = async (_bin, args) => {
    if (args[0] === 'ls-tree') return { stdout: `160000 commit ${'a'.repeat(40)}\tvendor\0` };
    throw new Error('cat-file must not be reached');
  };
  await assert.rejects(() => resolveCommandFile('vendor', { gitImpl }), (e) => e.code === 'COMMAND_FILE_NOT_A_FILE');
});

test('a missing file is refused', withGit, async () => {
  await assert.rejects(() => resolveCommandFile('examples/commands/does-not-exist.json'), (e) => e.code === 'COMMAND_FILE_NOT_TRACKED');
});

// An uncommitted file in the working tree is not part of the distribution, so
// it is not an immutable command this repository can be said to carry.
test('an untracked file inside the repository is refused', withGit, async () => {
  const untracked = path.join(repoRoot, 'untracked-probe.json');
  await writeFile(untracked, JSON.stringify({ marker: SECRET }), 'utf8');
  try {
    await assert.rejects(() => resolveCommandFile('untracked-probe.json'), (e) => e.code === 'COMMAND_FILE_NOT_TRACKED');
  } finally {
    await rm(untracked, { force: true });
  }
});

test('tracking cannot be skipped when git is unavailable', async () => {
  await assert.rejects(
    () => resolveCommandFile(TRACKED, { gitImpl: async () => { throw new Error('git: not found'); } }),
    (e) => e.code === 'COMMAND_FILE_NOT_TRACKED'
  );
});

// The gate echoes the command as the operation record. That record must never
// become a channel for publishing a file the gate had no business reading.
test('repository-external content is neither read nor printed', withGit, async () => {
  const printed = [];
  const requests = [];
  const link = path.join(repoRoot, 'escape-probe-2.json');
  await rm(link, { force: true });
  await symlink(path.join(scratch, 'outside.json'), link);

  try {
    await assert.rejects(
      () => runDispatch(
        { commandFile: 'escape-probe-2.json', endpoint: 'https://worker.example.com', controlSecret: 'c', commandSecret: 'd' },
        { log: (line) => printed.push(String(line)), fetchImpl: async (url) => { requests.push(url); throw new Error('must not be reached'); } }
      ),
      (e) => e.stage === 'command-source' && e.code === 'COMMAND_FILE_NOT_TRACKED'
    );

    const output = printed.join('\n');
    assert.ok(!output.includes(SECRET), 'external file content must never be printed');
    assert.equal(output.includes('validated command'), false, 'nothing may be echoed before validation');
    assert.deepEqual(requests, [], 'no request may be made for a rejected source');
  } finally {
    await rm(link, { force: true });
  }
});

test('an untracked file is rejected before its content is printed', withGit, async () => {
  const untracked = path.join(repoRoot, 'untracked-probe-2.json');
  await writeFile(untracked, JSON.stringify({ commandId: 'aaaaaaaa', marker: SECRET }), 'utf8');
  const printed = [];
  try {
    await assert.rejects(
      () => runDispatch(
        { commandFile: 'untracked-probe-2.json', endpoint: 'https://worker.example.com', controlSecret: 'c' },
        { log: (line) => printed.push(String(line)), fetchImpl: async () => { throw new Error('must not be reached'); } }
      ),
      (e) => e.code === 'COMMAND_FILE_NOT_TRACKED'
    );
    assert.ok(!printed.join('\n').includes(SECRET));
  } finally {
    await rm(untracked, { force: true });
  }
});

// The positive case: a committed, valid command is echoed, and only then.
test('a validated command is printed as the operation record', withGit, async () => {
  const printed = [];
  await runDispatch(
    { commandFile: TRACKED, endpoint: 'https://worker.example.com', controlSecret: 'c', dryRun: true },
    {
      log: (line) => printed.push(String(line)),
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.startsWith('/api/control/commands/')) return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, known: false, status: null }) };
        if (pathname === '/api/control/preflight/') return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, preflight: { commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', sideEffects: false } }) };
        throw new Error(`unexpected ${pathname}`);
      }
    }
  );
  const output = printed.join('\n');
  assert.ok(output.includes('--- validated command ---'));
  assert.ok(output.includes('"create_news"'));
});

// "Tracked" is not "unmodified". A committed command file edited in the working
// tree must dispatch the bytes the repository carries, not the local edit --
// and the edit must never appear in the operation record either.
test('a locally modified tracked file dispatches the committed blob', withGit, async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const target = path.join(repoRoot, TRACKED);
  const pristine = await readFile(target, 'utf8');
  const tampered = JSON.parse(pristine);
  tampered.payload.title = SECRET;
  tampered.payload.excerpt = SECRET;

  await writeFile(target, JSON.stringify(tampered, null, 2), 'utf8');
  try {
    // The resolver reads the blob, so the local edit is invisible to it.
    const resolved = await resolveCommandFile(TRACKED);
    assert.equal(JSON.parse(resolved.contents).payload.title, JSON.parse(pristine).payload.title);
    assert.ok(!resolved.contents.includes(SECRET), 'the committed blob must not contain the local edit');

    const printed = [];
    const dispatched = [];
    await runDispatch(
      { commandFile: TRACKED, endpoint: 'https://worker.example.com', controlSecret: 'c', commandSecret: 'd' },
      {
        log: (line) => printed.push(String(line)),
        fetchImpl: async (url, init) => {
          const pathname = new URL(url).pathname;
          if (pathname.startsWith('/api/control/commands/')) return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, known: false, status: null }) };
          if (pathname === '/api/control/preflight/') return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, preflight: { commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', sideEffects: false } }) };
          if (pathname === '/api/internal/commands') {
            dispatched.push(init.body);
            return { ok: true, status: 200, json: async () => ({ success: true, idempotent: false, result: {} }) };
          }
          throw new Error(`unexpected ${pathname}`);
        }
      }
    );

    assert.equal(dispatched.length, 1);
    assert.ok(!dispatched[0].includes(SECRET), 'the modified working-tree bytes must never be dispatched');
    assert.ok(!printed.join('\n').includes(SECRET), 'the modified working-tree bytes must never be printed');
  } finally {
    await writeFile(target, pristine, 'utf8');
  }
});
