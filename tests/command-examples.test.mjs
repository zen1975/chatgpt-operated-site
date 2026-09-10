import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCommandContracts, loadRuleVersion, repoRoot } from '../scripts/load-command-contracts.mjs';

const examplesDir = path.join(repoRoot, 'examples', 'commands');

const contracts = await loadCommandContracts();
const { RULE_VERSION } = await loadRuleVersion();

// Fields that identify a specific installation and must never ship as real
// values. Declared explicitly so a new example cannot skip the check.
const REQUIRED_PLACEHOLDERS = {
  'create-news.json': [],
  'create-news-with-image.json': ['payload.assets.0.providerAssetId'],
  'replace-content-image.json': ['payload.contentId', 'payload.reference.providerAssetId'],
  'update-page-hero.json': ['payload.pageId', 'payload.sectionId']
};

const exampleFiles = (await readdir(examplesDir))
  .filter((name) => name.endsWith('.json'))
  .sort();

test('the repository ships at least one command example', () => {
  assert.ok(exampleFiles.length > 0, 'examples/commands must contain command examples');
});

for (const file of exampleFiles) {
  const raw = JSON.parse(await readFile(path.join(examplesDir, file), 'utf8'));

  test(`${file} is a valid command envelope`, () => {
    const result = contracts.CommandEnvelope.safeParse(raw);
    assert.ok(result.success, `envelope rejected: ${JSON.stringify(result.error?.issues)}`);
  });

  test(`${file} payload matches the current schema for its command`, () => {
    const schema = contracts.COMMAND_PAYLOAD_SCHEMAS[raw.command];
    assert.ok(schema, `unknown command: ${raw.command}`);
    const result = schema.safeParse(raw.payload);
    assert.ok(result.success, `payload rejected: ${JSON.stringify(result.error?.issues)}`);
  });

  // executeCommand rejects any envelope whose ruleVersion differs from the
  // runtime constant, so an example carrying a decorative version is an
  // example that cannot actually be executed.
  test(`${file} carries the runtime rule version`, () => {
    assert.equal(
      raw.context.ruleVersion,
      RULE_VERSION,
      'example ruleVersion must equal the runtime rule version or the command is rejected with RULE_VERSION_CONFLICT'
    );
  });

  // Re-matching the strings that already matched the pattern proves nothing:
  // swapping a placeholder for a production identifier yields no matches and
  // passes. The fields that must stay placeholders are declared per example
  // instead, and every example must declare its expectation.
  test(`${file} keeps its installation-specific fields as placeholders`, () => {
    const expected = REQUIRED_PLACEHOLDERS[file];
    assert.ok(expected, `${file} must declare its required placeholder paths in REQUIRED_PLACEHOLDERS (use [] for an example with none)`);

    for (const pointer of expected) {
      const value = pointer.split('.').reduce((node, key) => (node === undefined ? undefined : node[key]), raw);
      assert.equal(typeof value, 'string', `${file}: ${pointer} must exist and be a string`);
      assert.match(
        value,
        /^REPLACE_WITH_[A-Z_]+$/,
        `${file}: ${pointer} must remain an obvious placeholder, never a real identifier from an installation`
      );
    }
  });

  // Catches a real identifier substituted into a field nobody declared.
  test(`${file} contains no identifier-shaped values`, () => {
    const findings = [];
    const walk = (node, pointer) => {
      if (typeof node === 'string') {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node)) findings.push(`${pointer}: uuid`);
        else if (/^[0-9a-f]{32,}$/i.test(node)) findings.push(`${pointer}: long hex`);
        else if (/^[A-Za-z0-9_-]{28,}$/.test(node) && !node.startsWith('REPLACE_WITH_')) findings.push(`${pointer}: opaque provider id`);
      } else if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) walk(child, pointer ? `${pointer}.${key}` : key);
      }
    };
    walk(raw, '');
    assert.deepEqual(findings, [], `${file} looks like it carries real identifiers:\n${findings.join('\n')}`);
  });
}

test('every command in the envelope enum has a payload schema', () => {
  const enumValues = contracts.CommandEnvelope.shape.command.options;
  const schemaKeys = Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS);
  assert.deepEqual([...enumValues].sort(), schemaKeys.sort());
});
