// Generates the published JSON Schemas from the authoritative Zod schemas.
//
// `schemas/*.json` are a publication artifact for consumers that cannot run the
// TypeScript. Hand-maintaining them let constraints drift silently, so they are
// generated instead: `npm run schemas:generate` writes them and
// `npm run test:contract` fails when a committed file no longer matches.
//
// Command payloads are generated in `input` mode: they describe what a caller
// may send, so a field with a Zod default is optional for the sender rather
// than required.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCommandContracts, repoRoot } from './load-command-contracts.mjs';

export async function generateSchemas() {
  const contracts = await loadCommandContracts();
  // Zod comes out of the same bundle as the schemas so that `.meta()`
  // constraints, which live in Zod's global registry, are visible here.
  const { z } = contracts;

  return {
    'schemas/command-envelope.schema.json': z.toJSONSchema(contracts.CommandEnvelope, { io: 'input' }),
    'schemas/create-news.schema.json': z.toJSONSchema(contracts.COMMAND_PAYLOAD_SCHEMAS.create_news, { io: 'input' }),
    // The intake descriptor is the `create_asset` payload minus its binary
    // transfer, which is deliberately not carried in command JSON.
    'schemas/asset-intake.schema.json': z.toJSONSchema(contracts.COMMAND_PAYLOAD_SCHEMAS.create_asset.shape.descriptor, { io: 'input' })
  };
}

export const serialize = (schema) => `${JSON.stringify(schema, null, 2)}\n`;

if (import.meta.filename === process.argv[1]) {
  const generated = await generateSchemas();
  for (const [relative, schema] of Object.entries(generated)) {
    await writeFile(path.join(repoRoot, relative), serialize(schema), 'utf8');
    console.log(`generated ${relative}`);
  }
}
