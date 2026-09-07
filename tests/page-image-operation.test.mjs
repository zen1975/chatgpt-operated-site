import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';
import { validateCommand, isImageBearingOperation, DispatchError } from '../scripts/dispatch-command.mjs';

// A page command can embed a canonical assetId in its module props, so
// image-bearing cannot be decided from the command name. The determination uses
// the page-composition registry's own extractor, so dispatch and the Worker
// share one definition of where an asset can appear.
const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');
const { MODULE_REGISTRY, extractModuleAssetReferences } = await loadServerModule('src/server/page-composition/registry.ts');
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;

const ASSET_ID = `asset_${'a'.repeat(64)}_original`;
const THUMB_ID = `asset_${'b'.repeat(64)}_thumbnail`;
const PAGE = { pageId: 'page_1', expectedVersion: 1 };
const SECTION = { ...PAGE, sectionId: 'section_1', expectedSectionVersion: 1 };

const envelope = (command, payload, requiresAssetIntake) => ({
  schemaVersion: 1,
  commandId: `page-image-${command.replace(/_/g, '-')}-0001`,
  command,
  issuedAt: '2026-09-07T00:00:00Z',
  context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID, ...(requiresAssetIntake === undefined ? {} : { requiresAssetIntake }) },
  payload
});

const heroSection = (withAsset) => ({ sectionType: 'hero', variant: 'standard', props: { title: 'Hero', ...(withAsset ? { assetId: ASSET_ID } : {}) } });
const mediaTextSection = (withAsset) => ({ sectionType: 'mediaText', variant: 'image-left', props: { title: 'Media', body: 'text', ...(withAsset ? { assetId: ASSET_ID } : {}) } });
const cardGridSection = (withAsset) => ({ sectionType: 'cardGrid', variant: 'service', props: { items: [{ id: 'a', title: 'One', ...(withAsset ? { assetId: THUMB_ID } : {}) }] } });
const richTextSection = () => ({ sectionType: 'richText', variant: 'standard', props: { blocks: [{ type: 'paragraph', content: 'text' }] } });
const reusableSection = () => ({ sectionType: 'reusable', variant: 'default', props: { ref: 'pattern-1' } });

/**
 * Every page command, with the reason it is or is not image-bearing.
 *
 * `carries` says whether that command can embed a canonical asset at all;
 * commands that cannot are image-bearing only when they are asset commands.
 */
const PAGE_COMMAND_MATRIX = [
  { command: 'create_page', carries: true, reason: 'seeds sections, whose module props may hold a canonical assetId',
    withAsset: { expectedVersion: 0, slug: 'about', title: 'About', pageType: 'standard', templateProfile: 'standard-default', sections: [richTextSection(), mediaTextSection(true)] },
    withoutAsset: { expectedVersion: 0, slug: 'about', title: 'About', pageType: 'standard', templateProfile: 'standard-default', sections: [richTextSection()] } },

  { command: 'insert_page_section', carries: true, reason: 'inserts one module, whose props may hold a canonical assetId',
    withAsset: { ...PAGE, position: 0, ...heroSection(true) },
    withoutAsset: { ...PAGE, position: 0, ...richTextSection() } },

  { command: 'update_page_section', carries: true, reason: 'replaces module props, which may hold a canonical assetId',
    withAsset: { ...SECTION, ...cardGridSection(true) },
    withoutAsset: { ...SECTION, ...richTextSection() } },

  { command: 'insert_page_section_item', carries: true, reason: 'inserts an item, whose registered item slot may hold a canonical assetId',
    withAsset: { ...SECTION, position: 0, item: { id: 'a', title: 'One', assetId: THUMB_ID } },
    withoutAsset: { ...SECTION, position: 0, item: { id: 'a', title: 'One' } } },

  { command: 'update_page_section_item', carries: true, reason: 'replaces an item, whose registered item slot may hold a canonical assetId',
    withAsset: { ...SECTION, itemId: 'a', item: { id: 'a', title: 'One', assetId: THUMB_ID } },
    withoutAsset: { ...SECTION, itemId: 'a', item: { id: 'a', title: 'One' } } },

  { command: 'update_page', carries: false, reason: 'changes page metadata only; module props are not part of its payload',
    withoutAsset: { ...PAGE, changes: { title: 'About us' } } },

  { command: 'remove_page_section', carries: false, reason: 'removes a section by id; carries no module props',
    withoutAsset: { ...SECTION } },

  { command: 'reorder_page_sections', carries: false, reason: 'reorders by id only',
    withoutAsset: { ...PAGE, sectionIds: ['section_1'] } },

  { command: 'remove_page_section_item', carries: false, reason: 'removes an item by id; carries no item body',
    withoutAsset: { ...SECTION, itemId: 'a' } },

  { command: 'reorder_page_section_items', carries: false, reason: 'reorders items by id only',
    withoutAsset: { ...SECTION, itemIds: ['a'] } },

  { command: 'rollback_page', carries: false, reason: 'names a stored revision; the assets it restores are already registered, and the payload carries none',
    withoutAsset: { ...PAGE, revisionId: 'rev_1' } },

  { command: 'replace_page_section_asset', carries: true, asset: true, reason: 'an asset command: places an asset by canonical id or provider reference',
    withAsset: { ...SECTION, assetPath: 'assetId', assetId: ASSET_ID } },

  { command: 'replace_page_section_item_asset', carries: true, asset: true, reason: 'an asset command: places an asset by canonical id',
    withAsset: { ...SECTION, itemId: 'a', assetId: ASSET_ID } }
];

test('the matrix covers every page command', async () => {
  const { loadCommandContracts } = await import('../scripts/load-command-contracts.mjs');
  const contracts = await loadCommandContracts();
  const pageCommands = contracts.CommandEnvelope.shape.command.options.filter((command) => command.includes('page'));
  assert.deepEqual([...pageCommands].sort(), PAGE_COMMAND_MATRIX.map((entry) => entry.command).sort());
});

for (const entry of PAGE_COMMAND_MATRIX) {
  if (entry.withAsset) {
    test(`${entry.command} with an asset: the flag is accepted (${entry.reason})`, async () => {
      const outcome = await validateCommand(envelope(entry.command, entry.withAsset, true));
      assert.equal(outcome.imageBearing, true);
    });

    test(`${entry.command} with an asset: omitting the flag is refused`, async () => {
      await assert.rejects(
        () => validateCommand(envelope(entry.command, entry.withAsset)),
        (error) => error instanceof DispatchError && error.code === 'ASSET_INTAKE_FLAG_MISSING'
      );
    });

    // A canonical asset needs no provider, so no readiness must be required.
    test(`${entry.command} with a canonical asset: no provider readiness`, async () => {
      const outcome = await validateCommand(envelope(entry.command, entry.withAsset, true));
      assert.equal(outcome.intake, null, 'a canonical asset must not require a provider readiness check');
    });
  }

  if (entry.withoutAsset) {
    test(`${entry.command} without an asset: omitting the flag is accepted (${entry.reason})`, async () => {
      const outcome = await validateCommand(envelope(entry.command, entry.withoutAsset));
      assert.equal(outcome.imageBearing, false);
      assert.equal(outcome.intake, null);
    });

    test(`${entry.command} without an asset: the flag is refused`, async () => {
      await assert.rejects(
        () => validateCommand(envelope(entry.command, entry.withoutAsset, true)),
        (error) => error.code === 'ASSET_INTAKE_FLAG_UNEXPECTED'
      );
    });
  }
}

// --------------------------------------------------------- slot-level detail

test('an asset in an array item is detected', async () => {
  const withItemAsset = { ...PAGE, position: 0, ...cardGridSection(true) };
  assert.equal(await isImageBearingOperation('insert_page_section', withItemAsset), true);

  const withoutItemAsset = { ...PAGE, position: 0, ...cardGridSection(false) };
  assert.equal(await isImageBearingOperation('insert_page_section', withoutItemAsset), false);
});

// A reusable section carries only a pattern reference. The registry declares no
// asset slot for it, and the assets live in the pattern, which the Worker
// resolves against D1. The gate has nothing to detect, and inventing a rule
// here would be a second definition of where assets live.
test('a reusable section carries no canonical asset of its own', async () => {
  assert.deepEqual(MODULE_REGISTRY.reusable.assetFields, {}, 'the registry declares no asset slot for reusable');
  assert.equal(await isImageBearingOperation('insert_page_section', { ...PAGE, position: 0, ...reusableSection() }), false);
});

test('a string field that is not a registered slot is not mistaken for an asset', async () => {
  // Unregistered key on a module that does declare an asset slot.
  assert.equal(await isImageBearingOperation('insert_page_section', {
    ...PAGE, position: 0, sectionType: 'hero', variant: 'standard', props: { title: 'Hero', backgroundAssetId: ASSET_ID }
  }), false, 'only the registry\'s declared slots count');

  // Registered slot name, but a value that is not a canonical asset id.
  assert.equal(await isImageBearingOperation('insert_page_section_item', {
    ...SECTION, position: 0, item: { id: 'a', assetId: 'a-plain-string' }
  }), false, 'a registered slot holding a non-asset value is not an asset reference');

  // A module with no asset slots at all.
  assert.equal(await isImageBearingOperation('insert_page_section', {
    ...PAGE, position: 0, sectionType: 'richText', variant: 'standard', props: { blocks: [], assetId: ASSET_ID }
  }), false, 'richText declares no asset slot, so an assetId there is not a module asset');
});

// ------------------------------------------------- registry is the source of truth

test('the determination follows the registry, not a gate-local list', async () => {
  const source = await readFile(path.join(repoRoot, 'scripts/dispatch-command.mjs'), 'utf8');

  assert.match(source, /extractModuleAssetReferences/, 'section assets must come from the registry extractor');
  assert.match(source, /MODULE_REGISTRY/, 'item slots must be derived from the registry');
  assert.ok(!/'items\[\]\.assetId'/.test(source), 'the gate must not restate a module asset path');
  assert.ok(!/JSON\.stringify\(payload\).*assetId|walk\(/.test(source), 'the gate must not scan payloads generically for asset-like keys');
});

test('every registered module asset slot is detected by the gate', async () => {
  // Enumerated from the registry, so a module that gains a slot is covered here
  // without this test being edited.
  for (const [type, entry] of Object.entries(MODULE_REGISTRY)) {
    for (const slot of Object.keys(entry.assetFields)) {
      const props = slot === 'assetId'
        ? { title: 'x', body: 'y', assetId: ASSET_ID }
        : { items: [{ id: 'a', title: 'One', assetId: THUMB_ID }] };

      const detected = await isImageBearingOperation('insert_page_section', { ...PAGE, position: 0, sectionType: type, variant: entry.allowedVariants[0], props });
      assert.equal(detected, true, `${type}.${slot} is a registered asset slot and must make the operation image-bearing`);

      // And the registry extractor agrees, so the two never diverge.
      assert.ok(extractModuleAssetReferences({ sectionType: type, props }).length > 0, `${type}: the registry extractor must see the same asset`);
    }
  }
});

test('a module with no asset slots is never image-bearing', async () => {
  for (const [type, entry] of Object.entries(MODULE_REGISTRY)) {
    if (Object.keys(entry.assetFields).length) continue;
    const detected = await isImageBearingOperation('insert_page_section', {
      ...PAGE, position: 0, sectionType: type, variant: entry.allowedVariants[0], props: { assetId: ASSET_ID, items: [{ assetId: THUMB_ID }] }
    });
    assert.equal(detected, false, `${type} declares no asset slot, so it must not be image-bearing`);
  }
});
