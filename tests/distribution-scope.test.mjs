import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/load-command-contracts.mjs';

const read = (relative) => readFile(path.join(repoRoot, relative), 'utf8');

// The files an implementer has to read to reproduce the control path. Growth
// here is the measurable form of the scope creep `AGENTS.md` warns about: every
// individual addition looks justified, so only a declared budget makes the
// aggregate visible. Raising it is allowed and is meant to be a deliberate,
// reviewable act rather than a side effect of a correct-looking fix.
const GOLDEN_PATH = [
  '.github/workflows/dispatch-command.yml',
  'scripts/dispatch-command.mjs',
  'src/server/site-identity.ts'
];
const GOLDEN_PATH_BUDGET = 400;

test('the golden path stays small enough to read', async () => {
  const sizes = await Promise.all(
    GOLDEN_PATH.map(async (file) => [file, (await read(file)).split('\n').length])
  );
  const total = sizes.reduce((sum, [, lines]) => sum + lines, 0);
  const breakdown = sizes.map(([file, lines]) => `  ${file}: ${lines}`).join('\n');

  assert.ok(
    total <= GOLDEN_PATH_BUDGET,
    `the dispatch golden path is ${total} lines, over the ${GOLDEN_PATH_BUDGET}-line budget:\n${breakdown}\n` +
      'Either move the addition to the implementer-hardening section of docs/DISPATCH_REFERENCE.md, ' +
      'or raise GOLDEN_PATH_BUDGET deliberately and say why in the commit.'
  );
});

// The scope rule only works if the out-of-scope list and the place it points at
// stay connected. Deleting an item from scope should require touching both
// files, which makes it a visible decision instead of a quiet one.
test('the out-of-scope list and the implementer-hardening section stay connected', async () => {
  const agents = await read('AGENTS.md');
  const reference = await read('docs/DISPATCH_REFERENCE.md');

  const section = agents.match(/## Distribution scope\n([\s\S]*?)\n## /);
  assert.ok(section, 'AGENTS.md must keep a "Distribution scope" section stating what this distribution refuses to carry');

  const items = section[1].split('\n').filter((line) => line.startsWith('- '));
  assert.ok(
    items.length >= 3,
    `the out-of-scope list must name what is excluded; found ${items.length} items`
  );

  assert.match(
    reference,
    /## Not included: implementer hardening/,
    'docs/DISPATCH_REFERENCE.md must keep the section the scope rule defers to, or the rule points at nothing'
  );
  assert.match(
    section[1],
    /docs\/DISPATCH_REFERENCE\.md/,
    'the out-of-scope list must say where an excluded concern is recorded instead'
  );
});
