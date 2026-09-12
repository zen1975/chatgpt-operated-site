import test from 'node:test';
import assert from 'node:assert/strict';
import { withSectionInserted } from '../src/server/page-composition/ordering.ts';

// A section row carries (page_id, position) under a unique index. If two
// sections end up sharing a position, or if the inserted section does not land
// on the position the command asked for, the write fails at the database with
// a constraint error the operator cannot act on. This was found by inserting a
// section in the middle of a live nine-section page: it succeeded at the end
// of the page and failed everywhere else.
const existing = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, position: i }));

test('an inserted section takes the position it asked for', () => {
  for (let position = 0; position <= 8; position += 1) {
    const result = withSectionInserted(existing(8), { id: 'new', position }, position);
    assert.equal(result.find((s) => s.id === 'new').position, position, `position ${position}`);
  }
});

test('positions stay unique and contiguous after an insert', () => {
  for (let position = 0; position <= 8; position += 1) {
    const positions = withSectionInserted(existing(8), { id: 'new', position }, position).map((s) => s.position);
    assert.deepEqual(positions, [0, 1, 2, 3, 4, 5, 6, 7, 8], `position ${position}`);
  }
});

// The tie-break that caused the original failure was alphabetical on id, so an
// id sorting after the displaced section's id was the case that broke.
test('the inserted id does not change where the section lands', () => {
  for (const id of ['aaa', 'zzz', 'proof', '14eed45e:section:6']) {
    const result = withSectionInserted(existing(8), { id, position: 5 }, 5);
    assert.equal(result.find((s) => s.id === id).position, 5, id);
    assert.equal(result.find((s) => s.id === 's5').position, 6, `displaced by ${id}`);
  }
});
