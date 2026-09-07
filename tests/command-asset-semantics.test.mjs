import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadCommandContracts, loadServerModule } from '../scripts/load-command-contracts.mjs';
import { validateCommand, runDispatch, isImageBearingOperation, extractCommandAssetReferences, DispatchError } from '../scripts/dispatch-command.mjs';

// "The payload contains an asset id" and "the operation is image-bearing" are
// not the same statement. Every command is classified explicitly, and the
// classification and the extraction both come from one server-side module.
const contracts = await loadCommandContracts();
const { COMMAND_ASSET_SEMANTICS } = await loadServerModule('src/server/command-assets.ts');
const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;

const ASSET_ID = `asset_${'a'.repeat(64)}_original`;
const CONTENT = { contentType: 'news', contentId: 'content_1', expectedVersion: 1 };
const PRODUCT = { productId: 'product_1', expectedVersion: 1 };
const TEXT_BLOCKS = [{ type: 'paragraph', content: 'body' }];
const IMAGE_BLOCKS = [{ type: 'paragraph', content: 'body' }, { type: 'image', assetId: ASSET_ID, alt: 'An image' }];

const envelope = (command, payload, requiresAssetIntake) => ({
  schemaVersion: 1,
  commandId: `asset-semantics-${command.replace(/_/g, '-')}-0001`,
  command,
  issuedAt: '2026-09-07T00:00:00Z',
  context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID, ...(requiresAssetIntake === undefined ? {} : { requiresAssetIntake }) },
  payload
});

// -------------------------------------------------------- matrix completeness

test('every command in the envelope is classified', () => {
  assert.deepEqual(
    Object.keys(COMMAND_ASSET_SEMANTICS).sort(),
    Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS).sort(),
    'the asset-semantics matrix and the payload schema map must name exactly the same commands, so a new command cannot be added without classifying it'
  );
});

test('every classification names a kind and a reason', () => {
  for (const [command, entry] of Object.entries(COMMAND_ASSET_SEMANTICS)) {
    assert.ok(['intrinsic', 'payload-derived', 'non-image'].includes(entry.semantics), `${command}: unknown semantics`);
    assert.ok(entry.reason && entry.reason.length > 15, `${command}: must state why`);
    if (entry.semantics === 'payload-derived') {
      assert.ok(entry.source, `${command}: a payload-derived command must name the schema or registry that decides`);
    }
  }
});

test('the classification counts match the audited command surface', () => {
  const byKind = Object.values(COMMAND_ASSET_SEMANTICS).reduce((counts, entry) => ({ ...counts, [entry.semantics]: (counts[entry.semantics] ?? 0) + 1 }), {});
  assert.equal(byKind.intrinsic, 7);
  assert.equal(byKind['payload-derived'], 8);
  assert.equal(byKind['non-image'], 18);
  assert.equal(Object.keys(COMMAND_ASSET_SEMANTICS).length, 33);
});

// ------------------------------------------------------------ content bodies

const CONTENT_CASES = [
  { command: 'create_news', withAsset: { title: 'Headline', blocks: IMAGE_BLOCKS }, withoutAsset: { title: 'Headline', blocks: TEXT_BLOCKS } },
  { command: 'update_content', withAsset: { ...CONTENT, changes: { blocks: IMAGE_BLOCKS } }, withoutAsset: { ...CONTENT, changes: { blocks: TEXT_BLOCKS } } },
  { command: 'create_product', withAsset: { expectedVersion: 0, slug: 'widget', title: 'Widget', primaryAssetId: ASSET_ID }, withoutAsset: { expectedVersion: 0, slug: 'widget', title: 'Widget' } }
];

for (const { command, withAsset, withoutAsset } of CONTENT_CASES) {
  test(`${command} carrying an asset requires the flag`, async () => {
    const accepted = await validateCommand(envelope(command, withAsset, true));
    assert.equal(accepted.imageBearing, true);

    await assert.rejects(
      () => validateCommand(envelope(command, withAsset)),
      (error) => error instanceof DispatchError && error.code === 'ASSET_INTAKE_FLAG_MISSING'
    );
  });

  test(`${command} carrying no asset refuses the flag`, async () => {
    const accepted = await validateCommand(envelope(command, withoutAsset));
    assert.equal(accepted.imageBearing, false);

    await assert.rejects(
      () => validateCommand(envelope(command, withoutAsset, true)),
      (error) => error.code === 'ASSET_INTAKE_FLAG_UNEXPECTED'
    );
  });

  test(`${command} with a canonical asset requires no provider`, async () => {
    const outcome = await validateCommand(envelope(command, withAsset, true));
    assert.equal(outcome.intake, null, 'a canonical asset must not trigger provider readiness');
  });
}

// ----------------------------------------------------------- false positives

test('non-image ContentAST blocks are not mistaken for assets', async () => {
  const blocks = [
    { type: 'paragraph', content: 'text' },
    { type: 'heading', level: 2, content: 'A heading' },
    { type: 'quote', content: 'quoted' },
    { type: 'unordered_list', items: ['one'] },
    { type: 'table', headers: ['h'], rows: [['c']] },
    { type: 'reusable', ref: 'pattern-1' },
    { type: 'separator' }
  ];
  assert.equal(await isImageBearingOperation('create_news', { blocks }), false);
  assert.deepEqual(await extractCommandAssetReferences('create_news', { blocks }), []);
});

// The extractor keys on the block type, not on the presence of a field. A
// generic search would treat any block carrying an assetId as an image.
test('only an image block declares an asset, whatever other blocks contain', async () => {
  const { extractContentAstAssetReferences } = await loadServerModule('src/server/core/content-ast.ts');

  const disguised = [
    { type: 'paragraph', content: 'text', assetId: ASSET_ID },
    { type: 'quote', content: 'quoted', assetId: ASSET_ID },
    { type: 'reusable', ref: 'pattern-1', assetId: ASSET_ID }
  ];
  assert.deepEqual(extractContentAstAssetReferences(disguised), [], 'a non-image block is not an asset reference, whatever field it carries');
  assert.equal(await isImageBearingOperation('create_news', { blocks: disguised }), false);

  // ...and an image block still is.
  const real = [...disguised, { type: 'image', assetId: ASSET_ID, alt: '' }];
  assert.equal(extractContentAstAssetReferences(real).length, 1, 'exactly the image block counts');
  assert.equal(await isImageBearingOperation('create_news', { blocks: real }), true);
});

test('a malformed asset id is not detected as an asset', async () => {
  // create_product declares a canonical asset field; a non-canonical value in
  // it is not an asset reference.
  assert.equal(await isImageBearingOperation('create_product', { primaryAssetId: 'not-an-asset' }), false);
  assert.equal(await isImageBearingOperation('create_product', { primaryAssetId: '' }), false);
  assert.equal(await isImageBearingOperation('create_product', { primaryAssetId: null }), false);

  // An image block with no assetId is not an asset reference either.
  assert.equal(await isImageBearingOperation('create_news', { blocks: [{ type: 'image', alt: 'no id' }] }), false);
});

test('a non-image command is never image-bearing, even carrying asset ids', async () => {
  // reorder passes asset ids but introduces none.
  assert.equal(await isImageBearingOperation('reorder_product_assets', { ...PRODUCT, role: 'gallery', assetIds: [ASSET_ID] }), false);
  assert.deepEqual(await extractCommandAssetReferences('reorder_product_assets', { assetIds: [ASSET_ID] }), []);

  // rollback names a revision; the assets it restores are already registered.
  assert.equal(await isImageBearingOperation('rollback_content', { ...CONTENT, revisionId: 'rev_1' }), false);
  assert.equal(await isImageBearingOperation('rollback_page', { pageId: 'page_1', expectedVersion: 1, revisionId: 'rev_1' }), false);

  // remove detaches only.
  assert.equal(await isImageBearingOperation('remove_product_asset', { ...PRODUCT, role: 'gallery' }), false);
});

test('the classification is enforced, not just described', async () => {
  for (const [command, entry] of Object.entries(COMMAND_ASSET_SEMANTICS)) {
    if (entry.semantics !== 'non-image') continue;
    // Whatever a non-image command carries, it stays non-image.
    const stuffed = { assetId: ASSET_ID, primaryAssetId: ASSET_ID, assetIds: [ASSET_ID], blocks: IMAGE_BLOCKS, item: { assetId: ASSET_ID } };
    assert.equal(await isImageBearingOperation(command, stuffed), false, `${command} is classified non-image and must stay so`);
  }
});

// --------------------------------------------------- no traffic for canonical

test('a canonical-only image operation performs no readiness request', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname.startsWith('/api/control/commands/')) {
      return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, known: false, status: null }) };
    }
    if (pathname === '/api/control/preflight/') {
      return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, preflight: { commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', sideEffects: false } }) };
    }
    throw new Error(`unexpected request to ${pathname}`);
  };

  const result = await runDispatch(
    { command: envelope('create_news', { title: 'Headline', blocks: IMAGE_BLOCKS }, true), endpoint: 'https://worker.example.com', controlSecret: 'c', dryRun: true },
    { fetchImpl, log: () => {} }
  );

  assert.equal(result.dispatched, false);
  assert.deepEqual(
    requests.filter((pathname) => pathname.includes('readiness')),
    [],
    'a canonical asset must produce zero readiness traffic'
  );
});

test('a provider reference does perform the readiness request', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname.startsWith('/api/control/commands/')) return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, known: false, status: null }) };
    if (pathname === '/api/control/readiness/asset-intake/') {
      // The installation issues a receipt bound to the command it was asked
      // about; the gate refuses to proceed without one.
      return { ok: true, status: 200, json: async () => ({
        success: true,
        siteId: SITE_ID,
        readiness: { status: 'READY', code: 'ASSET_INTAKE_READY', provider: 'google_drive', checks: [] },
        receipt: { receiptVersion: 1, commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', siteId: SITE_ID, provider: 'google_drive', readiness: 'READY', issuedAt: '2026-09-07T00:00:00Z', expiresAt: '2026-09-07T00:10:00Z', signature: 'a'.repeat(64) }
      }) };
    }
    if (pathname === '/api/control/preflight/') return { ok: true, status: 200, json: async () => ({ success: true, siteId: SITE_ID, preflight: { commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', sideEffects: false } }) };
    throw new Error(`unexpected request to ${pathname}`);
  };

  await runDispatch(
    {
      command: envelope('replace_asset', { ...CONTENT, role: 'hero', position: 0, reference: { provider: 'google_drive', providerAssetId: 'drive-1', intendedRole: 'hero' } }, true),
      endpoint: 'https://worker.example.com', controlSecret: 'c', dryRun: true
    },
    { fetchImpl, log: () => {} }
  );

  assert.ok(requests.includes('/api/control/readiness/asset-intake/'), 'a provider reference must be checked for readiness');
});

// ----------------------------------------------- new asset fields must be classified

test('a new canonical asset field cannot pass unclassified', async () => {
  // Every schema that declares a canonical asset id must belong to a command
  // classified as intrinsic or payload-derived. A newly added asset field on a
  // non-image command would fail here.
  const { z } = contracts;
  const offenders = [];

  for (const [command, schema] of Object.entries(contracts.COMMAND_PAYLOAD_SCHEMAS)) {
    let published;
    try {
      published = JSON.stringify(z.toJSONSchema(schema, { io: 'input' }));
    } catch {
      continue;
    }
    const declaresCanonicalAsset = /asset_\[a-f0-9\]\{64\}/.test(published) || /"blocks"/.test(published) || /"sections"/.test(published) || /"props"/.test(published);
    if (!declaresCanonicalAsset) continue;

    const semantics = COMMAND_ASSET_SEMANTICS[command]?.semantics;
    if (semantics === 'non-image') {
      // Permitted only with an explicit reason saying why the ids it carries do
      // not make it image-bearing.
      const reason = COMMAND_ASSET_SEMANTICS[command].reason;
      if (!/reorder|already registered|not canonical asset ids|detaches/.test(reason)) {
        offenders.push(`${command}: carries asset-shaped fields but is classified non-image without an explaining reason`);
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// ------------------------------------------------- digest excludes attestation

// A receipt binds itself to the command digest, so including it would be
// circular. The exclusion must be exactly that, and no wider.
test('the digest excludes attestation metadata and nothing else', async () => {
  const { commandDigest, commandForDigest, ATTESTATION_CONTEXT_KEYS } = await loadServerModule('src/server/control-plane/digest.ts');

  assert.deepEqual([...ATTESTATION_CONTEXT_KEYS].sort(), ['preflight', 'readinessReceipt']);

  const base = envelope('create_news', { title: 'Headline', blocks: TEXT_BLOCKS });
  const digest = await commandDigest(base);

  // Attaching either attestation leaves the digest unchanged.
  const withPreflight = { ...base, context: { ...base.context, preflight: { commandDigest: digest, contractVersion: 'v1' } } };
  const withReceipt = { ...base, context: { ...base.context, readinessReceipt: { receiptVersion: 1, commandDigest: digest, contractVersion: 'v1', siteId: SITE_ID, provider: 'generated', readiness: 'READY', issuedAt: '2026-09-07T00:00:00Z', expiresAt: '2026-09-07T00:10:00Z', signature: 'a'.repeat(64) } } };

  assert.equal(await commandDigest(withPreflight), digest, 'a preflight receipt must not change the digest');
  assert.equal(await commandDigest(withReceipt), digest, 'a readiness receipt must not change the digest');
  assert.equal(await commandDigest({ ...withPreflight, context: { ...withReceipt.context, ...withPreflight.context } }), digest, 'nor both together');

  // Everything else still changes it. This is the half that would break if the
  // exclusion were widened.
  const changed = {
    payload: { ...base, payload: { title: 'A different headline', blocks: TEXT_BLOCKS } },
    targetSite: { ...base, context: { ...base.context, targetSite: 'another-site' } },
    ruleVersion: { ...base, context: { ...base.context, ruleVersion: '9.9.9' } },
    requiresAssetIntake: { ...base, context: { ...base.context, requiresAssetIntake: true } },
    commandId: { ...base, commandId: 'a-different-command-id' },
    issuedAt: { ...base, issuedAt: '2026-01-01T00:00:00Z' }
  };
  for (const [field, variant] of Object.entries(changed)) {
    assert.notEqual(await commandDigest(variant), digest, `${field} is part of the command and must change its digest`);
  }

  // The retained context keys are visibly still there.
  const retained = commandForDigest(withReceipt);
  assert.deepEqual(Object.keys(retained.context).sort(), ['ruleVersion', 'targetSite']);
});
