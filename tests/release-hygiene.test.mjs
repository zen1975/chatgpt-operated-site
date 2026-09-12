import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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

// The one repository this distribution is allowed to name: its own canonical
// home. A fork keeps this value, because a fork still pulls from here.
//
// The slug is what is matched, not the full URL, so that `owner/repo#123` --
// GitHub's own cross-repository reference, and how a fork records the upstream
// pull request a change came from -- is permitted alongside the https form.
//
// The public roadmap is the second permitted context. GitHub Projects live in
// the owner's namespace rather than the repository's, and a repository-relative
// link does not reach them: the repository's Projects tab lists classic
// repository projects, and a linked Project does not appear there. So a
// distribution that may not write this path cannot link to its own roadmap.
const CANONICAL_OWNER = 'zen1975';
const CANONICAL_SLUG = `${CANONICAL_OWNER}/sitewright`;
const CANONICAL_PROJECTS = `users/${CANONICAL_OWNER}/projects/`;

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

// The distribution was extracted from a private upstream, and residual
// identifiers from that upstream are how private context leaks into a public
// repository.
//
// The owner handle is the exception, and it is a deliberate one. This rule was
// written while the upstream was private, where the handle was itself the
// thing being protected. The repository is now public at CANONICAL_REPOSITORY,
// and a distribution that may not name its own home cannot link to its issue
// tracker, its security advisories, or the upstream a fork pulls from -- which
// is how the rule started failing legitimate work.
//
// So the handle is permitted only as part of the canonical repository slug. A
// bare mention, a local path, or a reference to some other repository owned by
// the same account still fails, which is the part that was actually protective.
test('no tracked file carries private-upstream or operator identifiers', async () => {
  const markers = [/\bhack-sub\b/, /corporate-ai-site-starter/, /\bupnext-site\b/, /\/Users\//];
  const findings = [];
  for (const file of textFiles) {
    if (SELF_REFERENTIAL.has(file)) continue;
    const content = await readTracked(file);
    for (const marker of markers) {
      if (marker.test(content)) findings.push(`${file}: ${marker}`);
    }
    const stray = content.replaceAll(CANONICAL_SLUG, '').replaceAll(CANONICAL_PROJECTS, '');
    if (new RegExp(`\\b${CANONICAL_OWNER}\\b`).test(stray)) findings.push(`${file}: ${CANONICAL_OWNER} outside \`${CANONICAL_SLUG}\` and \`${CANONICAL_PROJECTS}\``);
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

/**
 * A stylesheet that names a token nothing defines fails silently: the browser
 * drops the declaration and renders whatever was underneath. That is how a
 * composed page shipped white text on a transparent background, visible to
 * anyone who rendered one and to no test.
 */
test('every CSS custom property used is also defined', async () => {
  const sheets = (await readdir('src/styles')).filter((f) => f.endsWith('.css'));
  const defined = new Set();
  const used = new Map();
  for (const sheet of sheets) {
    const css = await readFile(path.join(repoRoot, 'src/styles', sheet), 'utf8');
    for (const m of css.matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gi)) defined.add(m[2]);
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!used.has(m[1])) used.set(m[1], sheet);
    }
  }
  const missing = [...used.entries()].filter(([name]) => !defined.has(name));
  assert.deepEqual(missing.map(([n, f]) => `${f}: ${n}`), [],
    'CSS custom properties used but never defined');
});

/**
 * A font the distribution never loads is not a style choice, it is a leftover
 * from whatever theme the file was cut out of. It falls back silently and the
 * page renders in something else.
 */
test('stylesheets only name font families the distribution can actually use', async () => {
  const generic = new Set(['inherit', 'initial', 'unset', 'sans-serif', 'serif', 'monospace',
    'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', '-apple-system',
    'blinkmacsystemfont', 'segoe ui', 'helvetica', 'arial', 'georgia', 'menlo', 'monaco',
    'sfmono-regular', 'consolas', 'liberation mono', 'courier new', 'inter']);
  const sheets = (await readdir('src/styles')).filter((f) => f.endsWith('.css'));
  const findings = [];
  for (const sheet of sheets) {
    const css = await readFile(path.join(repoRoot, 'src/styles', sheet), 'utf8');
    const loaded = /@font-face|fonts\.googleapis\.com/.test(css);
    for (const m of css.matchAll(/"([^"]+)"/g)) {
      const family = m[1].trim().toLowerCase();
      if (!generic.has(family) && !loaded) findings.push(`${sheet}: "${m[1]}" is named but never loaded`);
    }
  }
  assert.deepEqual(findings, [], findings.join('\n'));
});

/**
 * `font: 700 2rem/1.2 inherit` is invalid: the shorthand needs a real family,
 * and `inherit` is only legal as the whole value. A browser discards the entire
 * declaration, so the text silently falls back to the user agent's size and
 * weight. Nothing in a build or a type check notices.
 */
test('no CSS font shorthand uses a keyword where a family belongs', async () => {
  const keywords = ['inherit', 'initial', 'unset', 'revert'];
  const sheets = (await readdir('src/styles')).filter((f) => f.endsWith('.css'));
  const findings = [];
  for (const sheet of sheets) {
    const css = await readFile(path.join(repoRoot, 'src/styles', sheet), 'utf8');
    for (const m of css.matchAll(/(^|[;{\s])font\s*:\s*([^;}]+)/gi)) {
      const value = m[2].trim();
      // The family sits at the end of the shorthand. Take the final token of the
      // final comma-separated entry, not the whole entry.
      const last = value.split(',').pop().trim().split(/\s+/).pop().toLowerCase();
      if (keywords.includes(last) && value.split(/\s+/).length > 1) {
        findings.push(`${sheet}: font: ${value}`);
      }
    }
  }
  assert.deepEqual(findings, [], findings.join('\n'));
});

/**
 * A page section that renders without an `id` cannot be linked to. The command
 * author chooses the section id, so in-page navigation (`/#roadmap`) is only
 * possible if the renderer puts that id on the element. Every module type needs
 * it, not just the ones that happen to carry one for accessibility.
 */
test('every page module section element renders an id', async () => {
  const file = 'src/components/page-modules/TrustedPageModule.astro';
  const source = await readFile(path.join(repoRoot, file), 'utf8');
  const findings = [];
  for (const m of source.matchAll(/<section\b[^>]*>/g)) {
    if (!/\sid=\{section\.id\}/.test(m[0])) findings.push(`${file}: ${m[0].slice(0, 80)}`);
  }
  assert.deepEqual(findings, [], findings.join('\n'));
});

/**
 * The mock pages (`about`, `contact`, `services`, the reference `index`, the
 * header and footer) are reference content: a fork replaces them, and they say
 * so on the page. The content routes are not. A fork keeps `news/` and
 * `column/` because that is where its operator publishes, so a company name
 * hardcoded there ships the reference site's identity in a real site's
 * `<title>`. It is read from `site.name` instead.
 */
test('content routes do not hardcode the reference site name', async () => {
  const routes = [
    'src/pages/news/index.astro', 'src/pages/news/[slug].astro',
    'src/pages/column/index.astro', 'src/pages/column/[slug].astro',
    'src/pages/[...slug].astro'
  ];
  const profile = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8'));
  assert.ok(profile.site.name, 'config/site-profile.json must carry site.name');
  const findings = [];
  for (const route of routes) {
    const source = await readFile(path.join(repoRoot, route), 'utf8');
    if (source.includes(profile.site.name)) findings.push(`${route}: hardcodes "${profile.site.name}"`);
  }
  assert.deepEqual(findings, [], findings.join('\n'));
});
