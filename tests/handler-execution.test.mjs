import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';
import { installWorkerRuntime } from './support/workers-runtime.mjs';

// These enter at the real handler. Source scans and hand-written SQL both
// passed while create_product handed raw statements to fencedBatch and the
// product/page paths queried D1 for assets they had not written yet.
const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;

const SHA = 'e'.repeat(64);
const PREPARED_ASSET_ID = `asset_${SHA}_original`;
const PREPARED_R2_KEY = `assets/${SHA.slice(0, 2)}/${SHA}.jpg`;

const envelope = (command, payload, commandId = `handler-${command.replace(/_/g, '-')}-0001`) => ({
  schemaVersion: 1,
  commandId,
  command,
  issuedAt: '2026-09-07T00:00:00Z',
  context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID },
  payload
});

/** A provider fetch that yields deterministic bytes for the reference paths. */
// A minimal but genuinely JPEG-shaped payload: intake validates the magic
// bytes and reads the dimensions out of the SOF0 segment, so arbitrary bytes
// are rejected long before anything is registered.
const bytes = new Uint8Array([
  0xff, 0xd8,                                     // SOI
  0xff, 0xc0, 0x00, 0x11, 0x08,                   // SOF0, length 17, 8-bit
  0x00, 0x64,                                     // height 100
  0x00, 0x64,                                     // width 100
  0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9                                      // EOI
]);

const generatedArtifactFetcher = async () => ({
  bytes,
  metadata: {
    sourceProvider: 'generated',
    sourceId: 'artifact-1',
    originalFilename: 'artifact.jpg',
    mimeType: 'image/jpeg',
    bytes: bytes.byteLength,
    sourceMetadata: {}
  }
});

async function withRuntime(run, overrides) {
  const runtime = await installWorkerRuntime(overrides);
  try {
    const { executeCommand, trustedCommandRuntime } = await loadServerModule('src/server/commands.ts');
    // The same trusted runtime the GitHub Actions ingress constructs, so scopes
    // are resolved from the environment exactly as in production.
    const execute = (command, extra = {}) => executeCommand(command, { ...trustedCommandRuntime(), ...extra });
    return await run(runtime, execute);
  } finally {
    runtime.dispose();
  }
}

const jobRow = (db, commandId) => db.prepare('SELECT status,result_json,command_digest FROM jobs WHERE command_id=?').get(commandId);

// ------------------------------------------------------------ create_product

// The regression: every element of this batch was a raw D1 statement, so
// fencedBatch mapped each to undefined and the batch failed before inserting
// anything. A source scan cannot see that; running the handler can.
test('create_product completes: product, revision and job success', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    const result = await executeCommand(envelope('create_product', { expectedVersion: 0, slug: 'widget', title: 'Widget' }));

    assert.equal(result.success, true);
    const products = runtime.db.prepare('SELECT id,slug,title,version FROM products').all();
    assert.equal(products.length, 1, 'the product must actually be inserted');
    assert.equal(products[0].slug, 'widget');

    const revisions = runtime.db.prepare("SELECT id FROM content_revisions WHERE content_type='product'").all();
    assert.equal(revisions.length, 1, 'the revision must be written in the same batch');

    const job = jobRow(runtime.db, 'handler-create-product-0001');
    assert.equal(job.status, 'success', 'the job must reach a terminal success');
    assert.ok(job.command_digest, 'and stay bound to its command digest');
  });
});

test('create_product is idempotent on replay and mutates once', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    const command = envelope('create_product', { expectedVersion: 0, slug: 'widget', title: 'Widget' });
    await executeCommand(command);
    const replay = await executeCommand(command);

    assert.equal(replay.idempotent, true);
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1, 'a replay must not create a second product');
  });
});

// ------------------------------------------- first-time provider-backed paths

async function seedContent(runtime) {
  runtime.db.prepare(`INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('content_1', 'headline', 'Headline', '[]', 'published', 1, 'now', 'now', 'news');
}

test('a first-time provider-backed replace_asset succeeds and registers the asset', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    await seedContent(runtime);

    const result = await executeCommand(
      envelope('replace_asset', {
        contentType: 'news', contentId: 'content_1', expectedVersion: 1, role: 'hero', position: 0,
        reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'hero' }
      }),
      { generatedArtifactFetcher }
    );

    assert.equal(result.success, true, 'a first-time provider-backed replacement must succeed');

    const assets = runtime.db.prepare('SELECT id,r2_key FROM assets').all();
    assert.equal(assets.length, 1, 'the asset is registered by the same batch');
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM content_assets').get().n, 1, 'and attached');
    assert.ok(runtime.storage.store.has(assets[0].r2_key), 'the committed metadata must point at an object that exists');
    assert.equal(jobRow(runtime.db, 'handler-replace-asset-0001').status, 'success');
  });
});

test('a first-time provider-backed replace_product_asset succeeds', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    await executeCommand(envelope('create_product', { expectedVersion: 0, slug: 'widget', title: 'Widget' }, 'seed-product-0001'));
    const product = runtime.db.prepare('SELECT id,version FROM products').get();

    const result = await executeCommand(
      envelope('replace_product_asset', {
        productId: product.id, expectedVersion: product.version, role: 'primary', position: 0,
        reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'hero' }
      }),
      { generatedArtifactFetcher }
    );

    assert.equal(result.success, true, 'a first-time provider-backed product asset must succeed');
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM product_assets').get().n, 1);
    assert.equal(jobRow(runtime.db, 'handler-replace-product-asset-0001').status, 'success');
  });
});

// -------------------------------------------------------- canonical asset ids

test('a canonical assetId that does not exist is still rejected', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    await seedContent(runtime);

    await assert.rejects(
      () => executeCommand(envelope('replace_asset', {
        contentType: 'news', contentId: 'content_1', expectedVersion: 1, role: 'hero', position: 0,
        assetId: `asset_${'f'.repeat(64)}_original`
      })),
      (error) => error.code === 'ASSET_NOT_FOUND',
      'a named asset must still be verified against D1'
    );

    assert.equal(jobRow(runtime.db, 'handler-replace-asset-0001').status, 'failed', 'and the job must end terminal');
  });
});

test('a canonical assetId that exists is accepted', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    await seedContent(runtime);
    runtime.db.prepare(`INSERT INTO assets (id,r2_key,original_filename,mime_type,bytes,alt,variant,created_at,source_provider,sha256,logical_asset_id,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(PREPARED_ASSET_ID, PREPARED_R2_KEY, 'a.jpg', 'image/jpeg', 4, '', 'original', 'now', 'generated', SHA, `logical_${SHA}`, 'validated');

    const result = await executeCommand(envelope('replace_asset', {
      contentType: 'news', contentId: 'content_1', expectedVersion: 1, role: 'hero', position: 0, assetId: PREPARED_ASSET_ID
    }));
    assert.equal(result.success, true);
  });
});

// --------------------------------------------------------------- atomicity

test('a version conflict rolls back registration, attachment, revision and success', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    await seedContent(runtime);

    await assert.rejects(
      () => executeCommand(
        envelope('replace_asset', {
          contentType: 'news', contentId: 'content_1', expectedVersion: 5, role: 'hero', position: 0,
          reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'hero' }
        }),
        { generatedArtifactFetcher }
      ),
      (error) => error.code === 'CONTENT_VERSION_CONFLICT' || error.code === 'VERSION_CONFLICT'
    );

    assert.deepEqual(runtime.db.prepare('SELECT id FROM assets').all(), [], 'no asset registration');
    assert.deepEqual(runtime.db.prepare('SELECT asset_id FROM content_assets').all(), [], 'no attachment');
    assert.notEqual(jobRow(runtime.db, 'handler-replace-asset-0001')?.status, 'success', 'and no success');
  });
});

test('every committed asset row points at an object that exists', async () => {
  await withRuntime(async (runtime, executeCommand) => {
    await seedContent(runtime);
    await executeCommand(
      envelope('replace_asset', {
        contentType: 'news', contentId: 'content_1', expectedVersion: 1, role: 'hero', position: 0,
        reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'hero' }
      }),
      { generatedArtifactFetcher }
    );

    for (const row of runtime.db.prepare('SELECT r2_key FROM assets').all()) {
      assert.ok(runtime.storage.store.has(row.r2_key), `${row.r2_key} must exist in the object store`);
    }
  });
});

// A raw statement reaching the batch is precisely the create_product defect.
test('a raw statement in a batch fails loudly rather than silently', async () => {
  await withRuntime(async (runtime) => {
    const { fencedBatch, claimCommand, named } = await loadServerModule('src/server/control-plane/job-store.ts');
    const { execution } = await claimCommand('raw-statement-probe-1', 'create_news', `sha256:${'a'.repeat(64)}`);

    const good = runtime.runtime.DB.prepare('SELECT 1');
    await assert.rejects(
      () => fencedBatch(execution, [{ name: 'raw', statement: undefined }]),
      /not a prepared statement/,
      'a statement that is not prepared must fail the batch'
    );
    await fencedBatch(execution, [named('probe', good)]);
  });
});

test('a first-time provider-backed replace_page_section_asset succeeds', async () => {
  await withRuntime(async (runtime, execute) => {
    // The starter's page capabilities only permit the "about" page, so the
    // command is exercised exactly where an installation allows it.
    const created = await execute(envelope('create_page', {
      expectedVersion: 0, slug: 'about', title: 'About', pageType: 'standard', templateProfile: 'standard-default',
      sections: [{ sectionType: 'hero', variant: 'standard', props: { title: 'About us' } }]
    }, 'seed-page-0001'));
    assert.equal(created.success, true);

    const page = runtime.db.prepare('SELECT id,version FROM pages').get();
    const section = runtime.db.prepare('SELECT id,version FROM page_sections').get();

    const result = await execute(
      envelope('replace_page_section_asset', {
        pageId: page.id, expectedVersion: page.version,
        sectionId: section.id, expectedSectionVersion: section.version,
        assetPath: 'assetId',
        reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'hero' }
      }),
      { generatedArtifactFetcher }
    );

    assert.equal(result.success, true, 'a first-time provider-backed section replacement must succeed');
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1, 'the asset is registered by the same batch');
    assert.equal(runtime.db.prepare('SELECT version FROM page_sections WHERE id=?').get(section.id).version, section.version + 1);
    assert.equal(jobRow(runtime.db, 'handler-replace-page-section-asset-0001').status, 'success');
  });
});

test('a page section replacement naming a missing canonical asset is rejected', async () => {
  await withRuntime(async (runtime, execute) => {
    await execute(envelope('create_page', {
      expectedVersion: 0, slug: 'about', title: 'About', pageType: 'standard', templateProfile: 'standard-default',
      sections: [{ sectionType: 'hero', variant: 'standard', props: { title: 'About us' } }]
    }, 'seed-page-0001'));
    const page = runtime.db.prepare('SELECT id,version FROM pages').get();
    const section = runtime.db.prepare('SELECT id,version FROM page_sections').get();

    await assert.rejects(
      () => execute(envelope('replace_page_section_asset', {
        pageId: page.id, expectedVersion: page.version,
        sectionId: section.id, expectedSectionVersion: section.version,
        assetPath: 'assetId', assetId: `asset_${'f'.repeat(64)}_original`
      })),
      (error) => error.code === 'PAGE_ASSET_UNUSABLE',
      'a named asset must still be verified against D1'
    );
  });
});

// ------------------------------------- partial section asset validation

/**
 * A section with two asset slots: the one being replaced by a provider
 * reference, and another already pointing at an unusable asset.
 *
 * Exempting the whole section during a provider-backed replacement would let
 * this commit with a broken reference still in place.
 */
async function seedMultiAssetSection(runtime, execute, { brokenSlot = true } = {}) {
  await execute(envelope('create_page', {
    expectedVersion: 0, slug: 'about', title: 'About', pageType: 'standard', templateProfile: 'standard-default',
    sections: [{ sectionType: 'cardGrid', variant: 'service', props: { items: [{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }] } }]
  }, 'seed-page-multi-0001'));

  const page = runtime.db.prepare('SELECT id,version FROM pages').get();
  const section = runtime.db.prepare('SELECT id,version,props_json FROM page_sections').get();

  // A second slot referencing an asset that exists but is unusable: its R2
  // object is absent, which is exactly what isAssetAvailable rejects.
  const otherAssetId = `asset_${'9'.repeat(64)}_original`;
  if (brokenSlot) {
    runtime.db.prepare(`INSERT INTO assets (id,r2_key,original_filename,mime_type,bytes,alt,variant,created_at,source_provider,sha256,logical_asset_id,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(otherAssetId, 'assets/missing.jpg', 'b.jpg', 'image/jpeg', 4, '', 'original', 'now', 'generated', '9'.repeat(64), `logical_${'9'.repeat(64)}`, 'validated');
    // No object is written to storage, so the asset is unavailable.
  }

  const props = JSON.parse(section.props_json);
  props.items[1].assetId = otherAssetId;
  runtime.db.prepare('UPDATE page_sections SET props_json=? WHERE id=?').run(JSON.stringify(props), section.id);

  return { page, section, otherAssetId };
}

test('a provider-backed replacement still validates the other slots', async () => {
  await withRuntime(async (runtime, execute) => {
    const { page, section } = await seedMultiAssetSection(runtime, execute);

    await assert.rejects(
      () => execute(
        envelope('replace_page_section_asset', {
          pageId: page.id, expectedVersion: page.version,
          sectionId: section.id, expectedSectionVersion: section.version,
          assetPath: 'items[0].assetId',
          reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'thumbnail' }
        }),
        { generatedArtifactFetcher }
      ),
      (error) => error.code === 'PAGE_ASSET_UNUSABLE',
      'an unusable asset in another slot must still fail the command'
    );

    // Nothing may have been committed.
    assert.deepEqual(runtime.db.prepare("SELECT id FROM assets WHERE source_provider='generated' AND sha256 != ?").all('9'.repeat(64)), [], 'no registration');
    assert.equal(runtime.db.prepare('SELECT version FROM page_sections WHERE id=?').get(section.id).version, section.version, 'no section update');
    assert.notEqual(jobRow(runtime.db, 'handler-replace-page-section-asset-0001')?.status, 'success', 'and no success');
  });
});

test('a provider-backed replacement succeeds when the other slots are usable', async () => {
  await withRuntime(async (runtime, execute) => {
    const { page, section } = await seedMultiAssetSection(runtime, execute, { brokenSlot: false });

    // The other slot points at nothing at all, so remove it and leave a single
    // replaceable slot; the point here is that validation still runs.
    const props = JSON.parse(runtime.db.prepare('SELECT props_json FROM page_sections WHERE id=?').get(section.id).props_json);
    delete props.items[1].assetId;
    runtime.db.prepare('UPDATE page_sections SET props_json=? WHERE id=?').run(JSON.stringify(props), section.id);

    const result = await execute(
      envelope('replace_page_section_asset', {
        pageId: page.id, expectedVersion: page.version,
        sectionId: section.id, expectedSectionVersion: section.version,
        assetPath: 'items[0].assetId',
        reference: { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'thumbnail' }
      }),
      { generatedArtifactFetcher }
    );

    assert.equal(result.success, true, 'the prepared asset itself must be exempt from the pre-registration lookup');
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  });
});
