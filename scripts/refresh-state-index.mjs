#!/usr/bin/env node
/**
 * Write the current content/page ids, versions and bodies into state/.
 *
 * update_content and update_page_section require an expectedVersion, but the
 * operator (ChatGPT) cannot compute an HMAC signature and therefore cannot read
 * the control plane directly. commands/** is a record of past operations, not
 * current state, so an expectedVersion copied from there is stale and every
 * update fails with a version conflict.
 *
 * GitHub Actions can sign, so it reads the current values here and commits them
 * to the repository, where the operator can read them as plain files.
 *
 * Usage: SITE_ENDPOINT and CONTROL_READ_HMAC_SECRET must be set.
 * Required read scopes: content:read, page:read.
 */
import { createHmac } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './repo-root.mjs';

const endpoint = (process.env.SITE_ENDPOINT || '').replace(/\/$/, '');
const secret = process.env.CONTROL_READ_HMAC_SECRET;
if (!endpoint || !secret) {
  console.error('SITE_ENDPOINT and CONTROL_READ_HMAC_SECRET are required.');
  process.exit(1);
}

/**
 * Always request the path with a trailing slash. astro.config.mjs sets
 * trailingSlash: 'always', and the signature covers the path, so an unslashed
 * path is redirected to a path that no longer matches the signature.
 *
 * The signature covers the path only -- the server verifies
 * `new URL(request.url).pathname` -- so a query string is sent but never
 * signed. Keep the two arguments separate; concatenating them into `pathname`
 * reintroduces the same class of 401 as the trailing slash did.
 */
async function read(pathname, query) {
  const timestamp = new Date().toISOString();
  const signature = createHmac('sha256', secret).update(`${timestamp}.GET.${pathname}`).digest('hex');
  const search = query && [...query.keys()].length ? `?${query}` : '';
  const res = await fetch(endpoint + pathname + search, {
    headers: { 'x-control-timestamp': timestamp, 'x-control-signature': signature }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) {
    throw new Error(`${pathname} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

// Do not build URLs here. config/permalink-profile.json is the single source,
// and the same file drives resolvePermalink() on the server. A second copy of
// the pattern goes stale the first time the permalink scheme changes, and the
// operator -- correctly trusting state/ -- then hands the requester a 404.
const permalinkProfile = JSON.parse(
  readFileSync(path.join(repoRoot, 'config/permalink-profile.json'), 'utf8')
);
const permalink = (item) => {
  const pattern = permalinkProfile[item.type];
  return typeof pattern === 'string' ? pattern.replace('{slug}', item.slug) : null;
};

/**
 * Follow the cursor to the end. The discovery endpoints return 50 rows by
 * default and hand back a `nextCursor`; reading only the first response drops
 * every item past the first page, and those items then have no index entry, no
 * body, and no section versions -- they cannot be operated on at all, silently.
 */
async function readAll(pathname, field) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 1000; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const body = await read(pathname, query);
    items.push(...(body[field] || []));
    cursor = body.nextCursor || null;
    if (!cursor) return items;
  }
  throw new Error(`${pathname}: cursor did not terminate`);
}

const contentItems = await readAll('/api/control/content/', 'content');
const pageItems = await readAll('/api/control/pages/', 'pages');

const now = new Date().toISOString();
const contentIndex = {
  note: 'Current content ids, versions and body locations. Read contentId and expectedVersion for update_content from here, and the body from the file that `body` points to. Do not read them from the published page, and do not copy them from commands/**.',
  generatedAt: now,
  items: contentItems
    .map((c) => ({ id: c.id, slug: c.slug, title: c.title, contentType: c.type, status: c.status, version: c.version, url: permalink(c) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
};
const pageIndex = {
  note: 'Current page ids and versions. Read pageId and expectedVersion for update_page_section from here; section ids and versions are under `sections`.',
  generatedAt: now,
  items: pageItems
    .map((p) => ({ id: p.id, slug: p.slug, title: p.title, pageType: p.type, status: p.status, version: p.version, url: `/${p.slug}/` }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
};

// Section versions are needed by update_page_section.
for (const item of pageIndex.items) {
  try {
    const detail = await read(`/api/control/pages/${encodeURIComponent(item.id)}/`);
    item.sections = (detail.sections || []).map((s) => ({
      sectionId: s.id, sectionType: s.sectionType, position: s.position, version: s.version
    }));
  } catch (error) {
    item.sectionsError = String(error.message).slice(0, 120);
  }
}

// Write out the current bodies. Without these the operator has to reconstruct
// the body from the published HTML when updating, which silently drops anything
// that rendering does not preserve, degrading the content on every update.
const bodiesDir = path.join(repoRoot, 'state/bodies');
await mkdir(bodiesDir, { recursive: true });
const bodyFiles = [];
for (const item of contentIndex.items) {
  try {
    const detail = await read(`/api/control/content/${encodeURIComponent(item.id)}/`);
    const body = detail.content;
    if (!body) continue;
    const name = `${body.contentType}-${body.slug}.json`;
    await writeFile(path.join(bodiesDir, name), JSON.stringify({
      note: 'Source of truth for the body passed to update_content. Use this, not the published page.',
      id: body.id,
      slug: body.slug,
      contentType: body.contentType,
      version: body.version,
      title: body.title,
      excerpt: body.excerpt,
      termIds: body.termIds,
      blocks: body.blocks,
    }, null, 2) + '\n', 'utf8');
    bodyFiles.push(name);
    item.body = `state/bodies/${name}`;
  } catch (error) {
    item.bodyError = String(error.message).slice(0, 120);
  }
}

await mkdir(path.join(repoRoot, 'state'), { recursive: true });
await writeFile(path.join(repoRoot, 'state/content-index.json'), JSON.stringify(contentIndex, null, 2) + '\n', 'utf8');
await writeFile(path.join(repoRoot, 'state/page-index.json'), JSON.stringify(pageIndex, null, 2) + '\n', 'utf8');
console.log(`state/content-index.json: ${contentIndex.items.length} item(s)`);
console.log(`state/bodies/           : ${bodyFiles.length} file(s)`);
console.log(`state/page-index.json   : ${pageIndex.items.length} page(s), ${pageIndex.items.reduce((n, p) => n + (p.sections?.length || 0), 0)} section(s)`);
