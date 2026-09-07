import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadCommandContracts, loadServerModule } from '../scripts/load-command-contracts.mjs';
import { canonicalCommandDigest } from '../scripts/dispatch-command.mjs';

// An exhaustive audit of the command surface. Every command the envelope
// advertises is externally dispatchable, and "advertised" has to mean
// executable: expressible in JSON, validated by a schema, routed by the gate,
// reachable in the Worker, and ending in a terminal job state.
const contracts = await loadCommandContracts();
const COMMANDS = [...contracts.CommandEnvelope.shape.command.options].sort();
const workerSource = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;
const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');

/** A minimal valid payload per command, used to prove the contract is inhabitable. */
const ASSET_ID = `asset_${'a'.repeat(64)}_original`;
const ISO = '2026-09-07T00:00:00Z';
const REFERENCE = { provider: 'google_drive', providerAssetId: 'drive-file-id', intendedRole: 'hero' };
const CONTENT_TARGET = { contentType: 'news', contentId: 'content_1', expectedVersion: 1 };
const PRODUCT_TARGET = { productId: 'product_1', expectedVersion: 1 };
const PAGE_TARGET = { pageId: 'page_1', expectedVersion: 1 };
const SECTION_TARGET = { ...PAGE_TARGET, sectionId: 'section_1', expectedSectionVersion: 1 };
const BLOCKS = [{ type: 'paragraph', content: 'body' }];

const SAMPLE_PAYLOADS = {
  create_news: { title: 'Headline', blocks: BLOCKS },
  create_taxonomy_term: { taxonomy: 'category', name: 'News', slug: 'news' },
  create_timed_content: { type: 'banner', placement: 'global_top', startsAt: ISO },
  import_wordpress_asset: { reference: { provider: 'wordpress', sourceId: '1234', sourceUrl: 'https://legacy.example.com/wp-content/uploads/a.jpg' } },
  update_content: { ...CONTENT_TARGET, changes: { title: 'New headline' } },
  archive_content: { ...CONTENT_TARGET },
  rollback_content: { ...CONTENT_TARGET, revisionId: 'rev_1' },
  schedule_content: { ...CONTENT_TARGET, startsAt: ISO },
  attach_asset: { ...CONTENT_TARGET, role: 'hero', assetId: 'asset_1' },
  replace_asset: { ...CONTENT_TARGET, role: 'hero', reference: REFERENCE },
  update_seo: { ...CONTENT_TARGET, seoTitle: 'Title', seoDescription: 'Description' },
  create_product: { expectedVersion: 0, slug: 'widget', title: 'Widget' },
  update_product: { ...PRODUCT_TARGET, changes: { title: 'Widget II' } },
  publish_product: { ...PRODUCT_TARGET },
  archive_product: { ...PRODUCT_TARGET },
  rollback_product: { ...PRODUCT_TARGET, revisionId: 'rev_1' },
  attach_product_asset: { ...PRODUCT_TARGET, role: 'gallery', assetId: ASSET_ID },
  replace_product_asset: { ...PRODUCT_TARGET, role: 'primary', assetId: ASSET_ID },
  remove_product_asset: { ...PRODUCT_TARGET, role: 'gallery' },
  reorder_product_assets: { ...PRODUCT_TARGET, role: 'gallery', assetIds: [ASSET_ID] },
  create_page: { expectedVersion: 0, slug: 'about', title: 'About', pageType: 'standard', templateProfile: 'standard' },
  update_page: { ...PAGE_TARGET, changes: { title: 'About us' } },
  rollback_page: { ...PAGE_TARGET, revisionId: 'rev_1' },
  insert_page_section: { ...PAGE_TARGET, position: 0, sectionType: 'richText', variant: 'default', props: {} },
  update_page_section: { ...SECTION_TARGET, sectionType: 'richText', variant: 'default', props: {} },
  remove_page_section: { ...SECTION_TARGET },
  reorder_page_sections: { ...PAGE_TARGET, sectionIds: ['section_1'] },
  replace_page_section_asset: { ...SECTION_TARGET, assetPath: 'assetId', assetId: ASSET_ID },
  insert_page_section_item: { ...SECTION_TARGET, position: 0, item: {} },
  update_page_section_item: { ...SECTION_TARGET, itemId: 'item_1', item: {} },
  remove_page_section_item: { ...SECTION_TARGET, itemId: 'item_1' },
  reorder_page_section_items: { ...SECTION_TARGET, itemIds: ['item_1'] },
  replace_page_section_item_asset: { ...SECTION_TARGET, itemId: 'item_1', assetId: ASSET_ID }
};

const envelopeFor = (command, payload) => ({
  schemaVersion: 1,
  commandId: `matrix-${command.replace(/_/g, '-')}-0001`,
  command,
  issuedAt: ISO,
  context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID },
  payload
});

test('the matrix covers every advertised command', () => {
  const covered = Object.keys(SAMPLE_PAYLOADS).sort();
  assert.deepEqual(covered, COMMANDS, 'every command in the envelope must have a matrix entry, and the matrix must not name commands the envelope does not advertise');
});

test('the envelope and the payload schema map agree exactly', () => {
  assert.deepEqual(COMMANDS, Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS).sort());
});

for (const command of COMMANDS) {
  const payload = SAMPLE_PAYLOADS[command];

  // An advertised command whose payload cannot survive JSON is not
  // dispatchable: the gate reads commands with JSON.parse and sends them with
  // JSON.stringify. This is what create_asset failed.
  test(`${command}: payload survives a JSON round trip`, () => {
    const round = JSON.parse(JSON.stringify(payload));
    assert.deepEqual(round, payload, `${command} has a payload that JSON cannot represent, so no operator could ever send it`);
  });

  test(`${command}: envelope and payload validate`, () => {
    const envelope = contracts.CommandEnvelope.safeParse(envelopeFor(command, payload));
    assert.ok(envelope.success, `envelope rejected: ${JSON.stringify(envelope.error?.issues)}`);

    const parsed = contracts.COMMAND_PAYLOAD_SCHEMAS[command].safeParse(payload);
    assert.ok(parsed.success, `payload rejected: ${JSON.stringify(parsed.error?.issues)}`);
  });

  test(`${command}: is reachable in the Worker`, () => {
    const routed =
      workerSource.includes(`cmd.command === '${command}'`) ||
      // Product and page commands are routed as sets to their own modules.
      new RegExp(`PRODUCT_COMMANDS[\\s\\S]{0,400}'${command}'`).test(workerSource) ||
      new RegExp(`PAGE_COMMANDS[\\s\\S]{0,600}'${command}'`).test(workerSource);
    assert.ok(routed, `${command} is advertised but has no handler branch in executeCommand`);
  });

  test(`${command}: has an authorization scope`, () => {
    assert.match(workerSource, new RegExp(`^\\s*${command}: `, 'm'), `${command} must appear in MUTATION_SCOPES`);
  });

  test(`${command}: is digestible, so it can be claimed and replayed`, async () => {
    const digest = await canonicalCommandDigest(envelopeFor(command, payload));
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  });
}

// Commands removed from the envelope must be gone everywhere, or the published
// contract advertises something no operator can send.
test('create_asset is not advertised as an operator command', async () => {
  assert.ok(!COMMANDS.includes('create_asset'));
  assert.ok(!Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS).includes('create_asset'));

  const published = JSON.parse(await readFile(path.join(repoRoot, 'schemas/command-envelope.schema.json'), 'utf8'));
  assert.ok(!published.properties.command.enum.includes('create_asset'), 'the published schema must not advertise it either');

  assert.ok(!/cmd\.command === 'create_asset'/.test(workerSource), 'the Worker must not carry a branch for an unadvertised command');
  assert.ok(!/^\s*create_asset: /m.test(workerSource), 'MUTATION_SCOPES must not carry a scope for an unadvertised command');
});

test('the documented public intake path is a bounded reference, not bytes', () => {
  // The reference-bearing commands are the supported way an image enters the
  // site. Each carries an identifier the Worker resolves; none carries bytes.
  for (const command of ['replace_asset', 'attach_product_asset', 'replace_product_asset', 'replace_page_section_asset']) {
    assert.ok(COMMANDS.includes(command), `${command} must remain advertised as a public intake path`);
  }
  const reference = contracts.AssetReference.safeParse(REFERENCE);
  assert.ok(reference.success);
  assert.ok(!('transfer' in reference.data), 'a provider reference must not carry a byte transfer');
});
