import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCommandContracts, loadRuleVersion, repoRoot } from '../scripts/load-command-contracts.mjs';

const examplesDir = path.join(repoRoot, 'examples', 'commands');

const contracts = await loadCommandContracts();
const { RULE_VERSION } = await loadRuleVersion();

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

  test(`${file} keeps placeholders obvious`, () => {
    const serialized = JSON.stringify(raw);
    for (const match of serialized.matchAll(/REPLACE_WITH_[A-Z_]+/g)) {
      assert.match(match[0], /^REPLACE_WITH_[A-Z_]+$/);
    }
  });
}

test('every command in the envelope enum has a payload schema', () => {
  const enumValues = contracts.CommandEnvelope.shape.command.options;
  const schemaKeys = Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS);
  assert.deepEqual([...enumValues].sort(), schemaKeys.sort());
});
