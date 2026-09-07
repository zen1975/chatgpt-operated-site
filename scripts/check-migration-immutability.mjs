#!/usr/bin/env node
// Base-relative migration immutability, for pull-request CI.
//
// This is the second half of a deliberately two-part guarantee:
//
//   1. migrations/CHECKSUMS.json pins migration content *inside* a
//      distribution. It needs no git, so it also runs in the Docker image,
//      where there is neither git metadata nor a git binary.
//   2. This check compares the migrations against the pull request's base
//      revision. The manifest alone cannot enforce immutability, because a
//      contributor can edit an applied migration, run
//      `npm run migrations:checksums`, commit both, and stay green. Only the
//      base revision knows what was already released.
//
// Every .sql migration present in the base must still exist byte-for-byte.
// Adding new migrations is allowed; modifying, deleting or renaming an existing
// one is not.
//
// Fails closed: if the base revision cannot be inspected, this exits non-zero
// rather than skipping. A check that silently passes when it cannot look is
// worse than no check at all.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';

const run = promisify(execFile);
const MIGRATIONS_PREFIX = 'migrations/';

class ImmutabilityCheckError extends Error {}

async function git(args) {
  try {
    const { stdout } = await run('git', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new ImmutabilityCheckError(`git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`);
  }
}

/**
 * The base revision, never hardcoded to a branch name. GitHub Actions passes
 * the pull request's own base SHA; `--base` covers local use.
 */
function resolveBaseRef(argv) {
  const flagIndex = argv.indexOf('--base');
  const fromFlag = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  const candidate =
    fromFlag ||
    process.env.MIGRATION_IMMUTABILITY_BASE ||
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);

  if (!candidate) {
    throw new ImmutabilityCheckError(
      'No base revision given. Pass --base <sha-or-ref>, or set MIGRATION_IMMUTABILITY_BASE / GITHUB_BASE_REF. ' +
        'This check fails closed rather than skipping when it cannot determine what was already released.'
    );
  }
  return candidate;
}

async function assertInspectable(baseRef) {
  await git(['rev-parse', '--git-dir']);
  // `^{commit}` makes this fail on a ref that exists but is not a commit, and
  // on a shallow clone that does not actually contain the base object.
  const resolved = (await git(['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
  return resolved;
}

async function baseMigrations(baseRef) {
  const stdout = await git(['ls-tree', '-r', '--name-only', baseRef, '--', MIGRATIONS_PREFIX]);
  return stdout.split('\n').filter((line) => line.endsWith('.sql')).sort();
}

/** Blob id of a path at a revision. */
const baseBlobId = async (baseRef, file) => (await git(['rev-parse', `${baseRef}:${file}`])).trim();

/** Blob id of the working-tree file, hashed the same way git would. */
const workingBlobId = async (file) => (await git(['hash-object', '--', file])).trim();

async function exists(file) {
  try {
    await access(path.join(repoRoot, file));
    return true;
  } catch {
    return false;
  }
}

export async function checkMigrationImmutability(baseRef) {
  const resolvedBase = await assertInspectable(baseRef);
  const inBase = await baseMigrations(resolvedBase);

  const modified = [];
  const removed = [];

  for (const file of inBase) {
    if (!(await exists(file))) {
      // Covers deletion and rename alike: a rename leaves the original path gone.
      removed.push(file);
      continue;
    }
    const [before, after] = await Promise.all([baseBlobId(resolvedBase, file), workingBlobId(file)]);
    if (before !== after) modified.push(file);
  }

  // Read the current side from disk rather than the index, so a migration that
  // has been written but not staged is still accounted for.
  const current = (await readdir(path.join(repoRoot, 'migrations')))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => `${MIGRATIONS_PREFIX}${name}`)
    .sort();
  const added = current.filter((file) => !inBase.includes(file));

  return { resolvedBase, inBase, added, modified, removed };
}

if (import.meta.filename === process.argv[1]) {
  try {
    const baseRef = resolveBaseRef(process.argv.slice(2));
    const result = await checkMigrationImmutability(baseRef);

    console.log(`base revision: ${result.resolvedBase}`);
    console.log(`migrations in base: ${result.inBase.length}`);
    console.log(`newly added (allowed): ${result.added.length ? result.added.join(', ') : 'none'}`);

    if (result.modified.length || result.removed.length) {
      console.error('\nMigration immutability violated.\n');
      for (const file of result.modified) {
        console.error(`  MODIFIED  ${file}`);
      }
      for (const file of result.removed) {
        console.error(`  REMOVED   ${file}  (deleted or renamed)`);
      }
      console.error(
        '\nThese migrations already exist in the base revision, so existing installations have applied them\n' +
          'and will never re-apply them. Editing one makes those databases diverge permanently from a database\n' +
          'built fresh. Regenerating migrations/CHECKSUMS.json does not make this safe -- it only records the\n' +
          'edit. Revert the change and add a new sequential migration instead.\n'
      );
      process.exit(1);
    }

    console.log('\nOK: every migration present in the base is unchanged.');
  } catch (error) {
    if (error instanceof ImmutabilityCheckError) {
      console.error(`Migration immutability check could not run: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
