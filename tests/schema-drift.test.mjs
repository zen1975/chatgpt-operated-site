import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCommandContracts, repoRoot } from '../scripts/load-command-contracts.mjs';
import { generateSchemas, serialize } from '../scripts/generate-schemas.mjs';

// The published schemas are generated from the authoritative Zod schemas, so
// drift is detected by regenerating and comparing the whole document rather
// than by spot-checking property names. Every constraint Zod can express --
// required, type, enum, const, format, pattern, minimum/maximum, min/maxLength,
// min/maxItems, uniqueItems, defaults, additionalProperties -- is covered by
// this comparison automatically, including for schemas added later.
const generated = await generateSchemas();

for (const [relative, schema] of Object.entries(generated)) {
  test(`${relative} matches the schema generated from the Zod source`, async () => {
    const committed = await readFile(path.join(repoRoot, relative), 'utf8');
    assert.equal(
      committed,
      serialize(schema),
      `${relative} is stale. Run \`npm run schemas:generate\` and commit the result.`
    );
  });
}

test('the generated schemas are deterministic', async () => {
  const second = await generateSchemas();
  for (const [relative, schema] of Object.entries(generated)) {
    assert.equal(serialize(schema), serialize(second[relative]), `${relative} generation is not deterministic`);
  }
});

// A generated document is only as good as the mode it was generated in.
// Command payloads describe what a caller may send, so a field carrying a Zod
// default must not be advertised as required.
test('payload schemas are published in input mode', async () => {
  const createNews = JSON.parse(await readFile(path.join(repoRoot, 'schemas/create-news.schema.json'), 'utf8'));
  assert.deepEqual(createNews.required, ['title', 'blocks']);
  for (const defaulted of ['contentType', 'templateProfile', 'categoryTermIds', 'tagTermIds']) {
    assert.ok(defaulted in createNews.properties, `${defaulted} must be published`);
    assert.ok(!createNews.required.includes(defaulted), `${defaulted} has a default and must not be published as required`);
  }
});

// The constraint the review found: the published schema declared uniqueItems
// while the Zod array accepted duplicates, and content_term_links is keyed by
// (content_type, content_id, term_id) with no conflict handling on insert.
test('taxonomy term ids are unique in both the runtime and the published contract', async () => {
  const contracts = await loadCommandContracts();
  const createNews = JSON.parse(await readFile(path.join(repoRoot, 'schemas/create-news.schema.json'), 'utf8'));
  const payload = { title: 'Example', blocks: [{ type: 'paragraph', content: 'body' }] };

  for (const field of ['categoryTermIds', 'tagTermIds']) {
    assert.equal(createNews.properties[field].uniqueItems, true, `${field} must publish uniqueItems`);
    assert.equal(
      contracts.COMMAND_PAYLOAD_SCHEMAS.create_news.safeParse({ ...payload, [field]: ['term_a', 'term_a'] }).success,
      false,
      `${field} must reject duplicates at the schema boundary, before the primary-key violation on insert`
    );
    assert.equal(
      contracts.COMMAND_PAYLOAD_SCHEMAS.create_news.safeParse({ ...payload, [field]: ['term_a', 'term_b'] }).success,
      true,
      `${field} must still accept distinct ids`
    );
  }
});

test('every command in the envelope enum has a payload schema', async () => {
  const contracts = await loadCommandContracts();
  assert.deepEqual(
    [...contracts.CommandEnvelope.shape.command.options].sort(),
    Object.keys(contracts.COMMAND_PAYLOAD_SCHEMAS).sort()
  );
});

// Not generated from Zod: the readiness document describes a control-plane
// response, which has no Zod counterpart in the implementation.
test('the hand-maintained readiness schema declares its dialect', async () => {
  const schema = JSON.parse(await readFile(path.join(repoRoot, 'schemas/asset-intake-readiness.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('every published schema is either generated or explicitly hand-maintained', async () => {
  const { readdir } = await import('node:fs/promises');
  const published = (await readdir(path.join(repoRoot, 'schemas'))).filter((name) => name.endsWith('.json')).sort();
  const accounted = [...Object.keys(generated).map((relative) => path.basename(relative)), 'asset-intake-readiness.schema.json'].sort();
  assert.deepEqual(published, accounted, 'a new schemas/*.json must be generated from Zod or added to the hand-maintained list');
});
