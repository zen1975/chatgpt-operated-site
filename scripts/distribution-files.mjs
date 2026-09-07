// Resolves the set of files the release-hygiene checks inspect.
//
// The checks must give the same answer in two environments: a git checkout,
// where `git ls-files` is authoritative, and a distribution that carries no git
// metadata at all -- notably the Docker image, whose build context excludes
// `.git` and whose base image has no `git` binary.
//
// The fallback walks the filesystem and applies the same exclusions the
// distribution itself uses. A fallback that quietly under-collects would make
// every hygiene check pass vacuously, so `assertUsableManifest` requires the
// result to contain the files a real checkout must have.
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';

const run = promisify(execFile);

/** Directories that are build output, dependencies, or tooling state. */
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', '.astro', '.wrangler', '.cache', 'coverage', '.github/.cache'
]);

/** Local-only files that must never be inspected as if they were distributed. */
const EXCLUDED_FILE = /^(\.dev\.vars(\..*)?|\.env(\..*)?|.*\.pem|.*\.key|service-account.*\.json|\.DS_Store|.*\.log)$/;

async function walk(directory, collected = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      await walk(absolute, collected);
    } else if (entry.isFile() && !EXCLUDED_FILE.test(entry.name)) {
      collected.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
    }
  }
  return collected;
}

async function gitManifest() {
  try {
    await stat(path.join(repoRoot, '.git'));
  } catch {
    return null;
  }
  try {
    const { stdout } = await run('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
    const files = stdout.split('\0').filter(Boolean);
    return files.length ? files : null;
  } catch {
    // No git binary, or not a working tree. Fall back to the filesystem.
    return null;
  }
}

/**
 * Files under inspection, plus which source produced them so a test can report
 * the environment it actually ran in.
 */
export async function distributionFiles() {
  const tracked = await gitManifest();
  if (tracked) return { source: 'git', files: tracked.sort() };
  return { source: 'filesystem', files: (await walk(repoRoot)).sort() };
}

/**
 * Files every distribution of this repository must contain. If the manifest is
 * missing any of them, the manifest is wrong -- and every hygiene check built
 * on it would otherwise pass by inspecting nothing.
 */
export const REQUIRED_IN_EVERY_DISTRIBUTION = [
  '.dockerignore',
  '.gitignore',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'README.md',
  'SECURITY.md',
  'astro.config.mjs',
  'config/rule-version.json',
  'config/site-profile.json',
  'docs/CONFIGURATION.md',
  'docs/GETTING_STARTED.md',
  'examples/commands/create-news.json',
  'examples/commands/replace-content-image.json',
  'migrations/0001_initial.sql',
  'package-lock.json',
  'package.json',
  'schemas/command-envelope.schema.json',
  'schemas/create-news.schema.json',
  'src/env.d.ts',
  'src/server/command-schema.ts',
  'src/server/commands.ts',
  'tsconfig.json',
  'wrangler.jsonc'
];

export function assertUsableManifest(manifest, assert) {
  const missing = REQUIRED_IN_EVERY_DISTRIBUTION.filter((file) => !manifest.files.includes(file));
  assert.deepEqual(
    missing,
    [],
    `the ${manifest.source} file manifest is missing files every distribution must ship, so the hygiene checks would inspect an incomplete set:\n${missing.join('\n')}`
  );
  // A checkout of this repository is well over a hundred files; a manifest far
  // below that means the walk or the exclusions are wrong.
  assert.ok(manifest.files.length >= 100, `the ${manifest.source} file manifest only found ${manifest.files.length} files`);
}
