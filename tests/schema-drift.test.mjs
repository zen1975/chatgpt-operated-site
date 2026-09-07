import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCommandContracts, repoRoot } from '../scripts/load-command-contracts.mjs';

// schemas/*.json are hand-maintained publication artifacts for consumers that
// cannot run the TypeScript. They are not the authority — src/server is — so
// these checks fail when the published copy falls behind the implementation.
const contracts = await loadCommandContracts();
const readJson = async (relative) => JSON.parse(await readFile(path.join(repoRoot, relative), 'utf8'));

test('published envelope schema lists exactly the implemented commands', async () => {
  const published = await readJson('schemas/command-envelope.schema.json');
  assert.deepEqual(
    [...published.properties.command.enum].sort(),
    [...contracts.CommandEnvelope.shape.command.options].sort()
  );
});

test('published envelope schema matches the implemented envelope shape', async () => {
  const published = await readJson('schemas/command-envelope.schema.json');
  assert.deepEqual(
    Object.keys(published.properties).sort(),
    Object.keys(contracts.CommandEnvelope.shape).sort()
  );
  assert.equal(published.additionalProperties, false, 'the envelope is strict in code and must be strict when published');
  assert.deepEqual(
    Object.keys(published.properties.context.properties).sort(),
    Object.keys(contracts.CommandEnvelope.shape.context.shape).sort()
  );
  assert.equal(published.properties.context.additionalProperties, false);
});

test('published create-news schema matches the implemented payload shape', async () => {
  const published = await readJson('schemas/create-news.schema.json');
  assert.deepEqual(
    Object.keys(published.properties).sort(),
    Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS.create_news.shape).sort()
  );
  assert.equal(published.additionalProperties, false);
});

test('every published schema is valid JSON with a declared dialect', async () => {
  for (const file of [
    'schemas/command-envelope.schema.json',
    'schemas/create-news.schema.json',
    'schemas/asset-intake.schema.json',
    'schemas/asset-intake-readiness.schema.json'
  ]) {
    const published = await readJson(file);
    assert.equal(published.$schema, 'https://json-schema.org/draft/2020-12/schema', `${file} must declare its JSON Schema dialect`);
  }
});
