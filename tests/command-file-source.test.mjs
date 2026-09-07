import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
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

test('a committed repository file resolves', withGit, async () => {
  const resolved = await resolveCommandFile(TRACKED);
  assert.equal(resolved.relativePath, TRACKED);
  assert.ok(resolved.absolutePath.startsWith(await (await import('node:fs/promises')).realpath(repoRoot)));
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
test('a symlink escaping the repository is refused', withGit, async () => {
  const link = path.join(repoRoot, 'escape-probe.json');
  await rm(link, { force: true });
  await symlink(path.join(scratch, 'outside.json'), link);
  try {
    await assert.rejects(
      () => resolveCommandFile('escape-probe.json'),
      (e) => e.code === 'COMMAND_FILE_OUTSIDE_REPOSITORY'
    );
  } finally {
    await rm(link, { force: true });
  }
});

test('a directory is refused', withGit, async () => {
  await assert.rejects(() => resolveCommandFile('examples/commands'), (e) => e.code === 'COMMAND_FILE_NOT_A_FILE');
});

test('a missing file is refused', withGit, async () => {
  await assert.rejects(() => resolveCommandFile('examples/commands/does-not-exist.json'), (e) => e.code === 'COMMAND_FILE_NOT_FOUND');
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
      (e) => e.stage === 'command-source' && e.code === 'COMMAND_FILE_OUTSIDE_REPOSITORY'
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
        if (pathname.startsWith('/api/control/commands/')) return { ok: true, status: 200, json: async () => ({ success: true, known: false, status: null }) };
        if (pathname === '/api/control/preflight/') return { ok: true, status: 200, json: async () => ({ success: true, preflight: { commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', sideEffects: false } }) };
        throw new Error(`unexpected ${pathname}`);
      }
    }
  );
  const output = printed.join('\n');
  assert.ok(output.includes('--- validated command ---'));
  assert.ok(output.includes('"create_news"'));
});
