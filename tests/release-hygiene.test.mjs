import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/load-command-contracts.mjs';
import { distributionFiles, assertUsableManifest } from '../scripts/distribution-files.mjs';
import { collectRuntimeConfigReads, NOT_CONFIGURATION } from '../scripts/collect-runtime-config.mjs';

// Resolved from git where git metadata exists, and from the filesystem
// otherwise, so these checks inspect the same set inside a Docker image that
// carries neither `.git` nor a git binary.
const manifest = await distributionFiles();
const tracked = manifest.files;

const readTracked = async (relative) => readFile(path.join(repoRoot, relative), 'utf8');
const textFiles = tracked.filter((file) => !/\.(png|jpg|jpeg|gif|webp|avif|ico|woff2?|pdf)$/i.test(file));

// Guards every check below: an under-collected manifest would make them pass
// by inspecting nothing.
test(`the ${manifest.source} file manifest is complete`, () => {
  assertUsableManifest(manifest, assert);
});

test('a public distribution ships its licence and release policy', () => {
  for (const required of ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', '.gitignore', '.dockerignore']) {
    assert.ok(tracked.includes(required), `${required} must be committed before public release`);
  }
});

test('.gitignore excludes local secret material', async () => {
  const ignore = await readTracked('.gitignore');
  for (const pattern of ['.dev.vars', '.env', 'node_modules/', 'dist/']) {
    assert.ok(ignore.includes(pattern), `.gitignore must cover ${pattern}`);
  }
});

// These files name the markers on purpose, so they cannot be scanned for them.
const SELF_REFERENTIAL = new Set(['tests/release-hygiene.test.mjs', 'scripts/distribution-files.mjs']);

// Values, not just filenames, are the risk here: this suite reports the file
// and the pattern class only, never the matched text.
const SECRET_PATTERNS = [
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, 'private key block'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/, 'stripe secret key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'github token'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}/, 'github fine-grained token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'google api key'],
  [/\bre_[A-Za-z0-9]{24,}/, 'resend api key']
];

test('no tracked file contains credential material', async () => {
  const findings = [];
  for (const file of textFiles) {
    const content = await readTracked(file);
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(findings, [], `credential-shaped content found:\n${findings.join('\n')}`);
});

// The distribution claims to be a neutral English starter extracted from a
// private upstream. Residual identifiers from that upstream are how private
// context leaks into a public repository.
test('no tracked file carries private-upstream or operator identifiers', async () => {
  const markers = [/\bhack-sub\b/, /\bzen1975\b/, /corporate-ai-site-starter/, /\bupnext-site\b/, /\/Users\//];
  const findings = [];
  for (const file of textFiles) {
    if (SELF_REFERENTIAL.has(file)) continue;
    const content = await readTracked(file);
    for (const marker of markers) {
      if (marker.test(content)) findings.push(`${file}: ${marker}`);
    }
  }
  assert.deepEqual(findings, [], `private-upstream markers found:\n${findings.join('\n')}`);
});

test('the distribution is English-only', async () => {
  const cjk = /[぀-ヿ一-鿿]/;
  const findings = [];
  for (const file of textFiles) {
    if (SELF_REFERENTIAL.has(file)) continue;
    if (cjk.test(await readTracked(file))) findings.push(file);
  }
  assert.deepEqual(findings, [], `non-English content in a neutral English distribution:\n${findings.join('\n')}`);
});

test('production identifiers are not committed as configuration', async () => {
  const wrangler = await readTracked('wrangler.jsonc');
  assert.match(wrangler.match(/"database_id":\s*"([^"]*)"/)[1], /^0{8}-0{4}-0{4}-0{4}-0{12}$/, 'wrangler.jsonc must ship a placeholder D1 id');
  assert.match(wrangler.match(/"id":\s*"([^"]*)"/)[1], /^0{32}$/, 'wrangler.jsonc must ship a placeholder KV id');
  for (const key of ['name', 'database_name', 'bucket_name']) {
    const value = wrangler.match(new RegExp(`"${key}":\\s*"([^"]*)"`))[1];
    assert.match(value, /^replace-me-/, `wrangler.jsonc ${key} must remain an obvious placeholder`);
  }
});

test('every Makefile target maps to a real npm script', async () => {
  const [makefile, pkg] = await Promise.all([readTracked('Makefile'), readTracked('package.json')]);
  const scripts = Object.keys(JSON.parse(pkg).scripts);
  for (const [, script] of makefile.matchAll(/npm run ([a-z0-9:-]+)/g)) {
    assert.ok(scripts.includes(script), `Makefile calls "npm run ${script}" which package.json does not define`);
  }
  for (const [, file] of makefile.matchAll(/\.\/([\w./-]+\.sh)/g)) {
    assert.ok(tracked.includes(file), `Makefile calls ${file} which is not committed`);
  }
});

test('the Dockerfile only copies files the repository ships', async () => {
  const dockerfile = await readTracked('Dockerfile');
  for (const [, sources] of dockerfile.matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)) {
    for (const source of sources.split(/\s+/)) {
      if (source === '.' || source.includes('*')) continue;
      assert.ok(tracked.includes(source), `Dockerfile copies ${source} which is not committed`);
    }
  }
});

test('every wrangler binding and var is declared in the runtime env type', async () => {
  const [wrangler, envTypes] = await Promise.all([readTracked('wrangler.jsonc'), readTracked('src/env.d.ts')]);
  const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ''));
  const bindings = [
    ...(config.d1_databases || []).map((entry) => entry.binding),
    ...(config.r2_buckets || []).map((entry) => entry.binding),
    ...(config.kv_namespaces || []).map((entry) => entry.binding),
    ...Object.keys(config.vars || {})
  ];
  for (const binding of bindings) {
    assert.match(envTypes, new RegExp(`\\b${binding}\\??:`), `wrangler.jsonc declares ${binding} but src/env.d.ts does not type it`);
  }
});

// Enumerating expected names by hand is how WORDPRESS_ASSET_ALLOWED_ORIGINS
// stayed undocumented while the Worker rejected every WordPress import without
// it. The expected set is derived from the implementation instead.
test('every environment name the implementation reads is typed', async () => {
  const [reads, envTypes] = await Promise.all([collectRuntimeConfigReads(), readTracked('src/env.d.ts')]);
  const undeclared = [];
  for (const [name, files] of reads) {
    if (!new RegExp(`\\b${name}\\??:`).test(envTypes)) undeclared.push(`${name} (read in ${[...files].join(', ')})`);
  }
  assert.deepEqual(undeclared, [], `src/env.d.ts does not declare:\n${undeclared.join('\n')}`);
});

test('every environment name the implementation reads is documented', async () => {
  const [reads, doc] = await Promise.all([collectRuntimeConfigReads(), readTracked('docs/CONFIGURATION.md')]);
  const undocumented = [];
  for (const [name, files] of reads) {
    if (NOT_CONFIGURATION.has(name)) continue;
    if (!doc.includes(name)) undocumented.push(`${name} (read in ${[...files].join(', ')})`);
  }
  assert.deepEqual(undocumented, [], `docs/CONFIGURATION.md does not document:\n${undocumented.join('\n')}`);
});

test('every wrangler binding and var is documented for installers', async () => {
  const [wrangler, doc] = await Promise.all([readTracked('wrangler.jsonc'), readTracked('docs/CONFIGURATION.md')]);
  const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ''));
  const declared = [
    ...(config.d1_databases || []).map((entry) => entry.binding),
    ...(config.r2_buckets || []).map((entry) => entry.binding),
    ...(config.kv_namespaces || []).map((entry) => entry.binding),
    ...Object.keys(config.vars || {})
  ];
  for (const name of declared) {
    assert.ok(doc.includes(name), `docs/CONFIGURATION.md must document the ${name} binding or variable`);
  }
});

test('.dockerignore excludes local dependencies and secret material', async () => {
  const dockerignore = await readTracked('.dockerignore');
  const patterns = dockerignore.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const required of [
    '.git', 'node_modules', 'dist', '.astro', '.wrangler', '.dev.vars', '.dev.vars.*',
    '.env', '.env.*', '*.pem', '*.key', 'service-account*.json', 'coverage', '.cache', '.DS_Store', '*.log'
  ]) {
    assert.ok(patterns.includes(required), `.dockerignore must exclude ${required}`);
  }

  // Excluding these would ship an image whose contract checks inspect nothing.
  for (const kept of ['examples', 'schemas', 'config', 'migrations', 'tests', 'scripts', 'src', 'docs', 'package.json', 'package-lock.json']) {
    assert.ok(!patterns.includes(kept), `.dockerignore must not exclude ${kept}: the image runs the contract checks against it`);
  }
});
