import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadCommandContracts, loadServerModule } from '../scripts/load-command-contracts.mjs';
import { validateCommand, isImageBearingOperation, DispatchError } from '../scripts/dispatch-command.mjs';

// "Is this image-bearing?" and "must a provider be ready?" are different
// questions. Collapsing them into one boolean rejected every compliant command
// that named an existing canonical assetId, because such a command needs no
// provider yet is still image-bearing under the operating contract.
const contracts = await loadCommandContracts();
const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;

const ASSET_ID = `asset_${'a'.repeat(64)}_original`;
const REFERENCE = { provider: 'google_drive', providerAssetId: 'drive-file-id', intendedRole: 'hero' };
const CONTENT = { contentType: 'news', contentId: 'content_1', expectedVersion: 1 };
const PRODUCT = { productId: 'product_1', expectedVersion: 1 };
const SECTION = { pageId: 'page_1', expectedVersion: 1, sectionId: 'section_1', expectedSectionVersion: 1 };

const envelope = (command, payload, requiresAssetIntake) => ({
  schemaVersion: 1,
  commandId: `image-contract-${command.replace(/_/g, '-')}-0001`,
  command,
  issuedAt: '2026-09-07T00:00:00Z',
  context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID, ...(requiresAssetIntake === undefined ? {} : { requiresAssetIntake }) },
  payload
});

/**
 * Every image-bearing command, in both forms its asset can take. The canonical
 * column is what regressed: those commands must be accepted with the flag and
 * must not trigger a readiness check.
 */
const IMAGE_BEARING = {
  attach_asset: { canonical: { ...CONTENT, role: 'hero', assetId: 'asset_1' } },
  replace_asset: { canonical: { ...CONTENT, role: 'hero', assetId: 'asset_1' }, reference: { ...CONTENT, role: 'hero', reference: REFERENCE } },
  attach_product_asset: { canonical: { ...PRODUCT, role: 'gallery', assetId: ASSET_ID } },
  replace_product_asset: { canonical: { ...PRODUCT, role: 'primary', assetId: ASSET_ID }, reference: { ...PRODUCT, role: 'primary', reference: REFERENCE } },
  replace_page_section_asset: { canonical: { ...SECTION, assetPath: 'assetId', assetId: ASSET_ID }, reference: { ...SECTION, assetPath: 'assetId', reference: REFERENCE } },
  replace_page_section_item_asset: { canonical: { ...SECTION, itemId: 'item_1', assetId: ASSET_ID } },
  import_wordpress_asset: { reference: { reference: { provider: 'wordpress', sourceId: '1', sourceUrl: 'https://legacy.example.com/a.jpg' } } }
};

/** Commands that are not image-bearing and must reject the flag. */
const NOT_IMAGE_BEARING = {
  create_news: { title: 'Headline', blocks: [{ type: 'paragraph', content: 'body' }] },
  remove_product_asset: { ...PRODUCT, role: 'gallery' },
  reorder_product_assets: { ...PRODUCT, role: 'gallery', assetIds: [ASSET_ID] },
  update_content: { ...CONTENT, changes: { title: 'New' } }
};

test('the asset commands are image-bearing whatever their payload', async () => {
  for (const [command, forms] of Object.entries(IMAGE_BEARING)) {
    for (const payload of Object.values(forms)) {
      assert.equal(await isImageBearingOperation(command, payload), true, `${command} must be image-bearing`);
    }
  }
});

test('commands that carry no asset are not image-bearing', async () => {
  for (const [command, payload] of Object.entries(NOT_IMAGE_BEARING)) {
    assert.equal(await isImageBearingOperation(command, payload), false, `${command} must not be image-bearing`);
  }
});

for (const [command, forms] of Object.entries(IMAGE_BEARING)) {
  for (const [form, payload] of Object.entries(forms)) {
    test(`${command} (${form}): the required flag is accepted`, async () => {
      const outcome = await validateCommand(envelope(command, payload, true));
      assert.equal(outcome.imageBearing, true);
    });

    test(`${command} (${form}): omitting the flag is refused`, async () => {
      await assert.rejects(
        () => validateCommand(envelope(command, payload)),
        (error) => error instanceof DispatchError && error.code === 'ASSET_INTAKE_FLAG_MISSING',
        'the contract requires the flag on every image-bearing operation'
      );
    });

    // The distinction the earlier defect erased.
    test(`${command} (${form}): readiness runs only for a provider reference`, async () => {
      const outcome = await validateCommand(envelope(command, payload, true));
      if (form === 'canonical') {
        assert.equal(outcome.intake, null, 'a canonical assetId must not require provider readiness');
      } else {
        assert.ok(outcome.intake, 'a provider reference must require readiness');
        assert.ok(outcome.intake.provider, 'and must name the provider to check');
      }
    });
  }
}

for (const [command, payload] of Object.entries(NOT_IMAGE_BEARING)) {
  test(`${command}: the flag is refused`, async () => {
    await assert.rejects(
      () => validateCommand(envelope(command, payload, true)),
      (error) => error.code === 'ASSET_INTAKE_FLAG_UNEXPECTED'
    );
  });

  test(`${command}: omitting the flag is accepted`, async () => {
    const outcome = await validateCommand(envelope(command, payload));
    assert.equal(outcome.imageBearing, false);
    assert.equal(outcome.intake, null);
  });
}

// ------------------------------------------------ attach commands are canonical-only

test('the attach commands reject a provider reference at the schema', () => {
  for (const command of ['attach_asset', 'attach_product_asset', 'replace_page_section_item_asset']) {
    const schema = contracts.COMMAND_PAYLOAD_SCHEMAS[command];
    const base = command === 'attach_asset'
      ? { ...CONTENT, role: 'hero' }
      : command === 'attach_product_asset'
        ? { ...PRODUCT, role: 'gallery' }
        : { ...SECTION, itemId: 'item_1' };

    assert.equal(schema.safeParse({ ...base, reference: REFERENCE }).success, false, `${command} must reject a reference`);
    assert.equal(
      schema.safeParse({ ...base, assetId: command === 'attach_asset' ? 'asset_1' : ASSET_ID }).success,
      true,
      `${command} must accept a canonical assetId`
    );
  }
});

test('the documentation does not advertise references for canonical-only commands', async () => {
  const files = ['docs/DISPATCH_GATE.md', 'docs/DAILY_OPERATION.md', 'docs/CONFIGURATION.md', 'README.md', 'src/server/command-schema.ts'];

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    for (const line of source.split('\n')) {
      // A line that names a canonical-only command must not also present
      // payload.reference as one of its inputs.
      const namesAttach = /attach_product_asset|attach_asset|replace_page_section_item_asset/.test(line);
      const offersReference = /payload\.reference|provider reference|AssetReference/.test(line);
      const excludes = /never|only|reject|canonical `assetId` only|not applicable/.test(line);
      assert.ok(
        !(namesAttach && offersReference && !excludes),
        `${file}: this line advertises a provider reference for a canonical-only command:\n  ${line.trim().slice(0, 160)}`
      );
    }
  }
});

test('the gate only treats reference-capable commands as reference-bearing', async () => {
  const source = await readFile(path.join(repoRoot, 'scripts/dispatch-command.mjs'), 'utf8');
  const block = source.slice(source.indexOf('const REFERENCE_BEARING_COMMANDS = new Set(['), source.indexOf(']);', source.indexOf('const REFERENCE_BEARING_COMMANDS')));

  for (const command of ['replace_asset', 'replace_product_asset', 'replace_page_section_asset']) {
    assert.ok(block.includes(`'${command}'`), `${command} accepts a reference and must be listed`);
  }
  for (const command of ['attach_asset', 'attach_product_asset', 'replace_page_section_item_asset']) {
    assert.ok(!block.includes(`'${command}'`), `${command} rejects a reference and must not be listed`);
  }

  // And the list agrees with the schemas themselves.
  for (const command of ['replace_asset', 'replace_product_asset', 'replace_page_section_asset']) {
    const schema = contracts.COMMAND_PAYLOAD_SCHEMAS[command];
    const base = command === 'replace_asset' ? { ...CONTENT, role: 'hero' } : command === 'replace_product_asset' ? { ...PRODUCT, role: 'primary' } : { ...SECTION, assetPath: 'assetId' };
    assert.equal(schema.safeParse({ ...base, reference: REFERENCE }).success, true, `${command} must accept a reference`);
  }
});
