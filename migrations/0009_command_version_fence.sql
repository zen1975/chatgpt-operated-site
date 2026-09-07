-- Append-only migration. 0001-0008 are immutable.
--
-- Optimistic version checks were enforced by inspecting affected rows *after*
-- the batch had run. That is not a safety boundary: a guarded UPDATE matching
-- zero rows is not an error, so D1 commits every other statement in the
-- sequence and the check only discovers afterwards that the mutation it was
-- guarding never applied. Revisions, projections and the success transition
-- could all land against a row whose version was never advanced.
--
-- The same shape as the lease fence: a statement that FAILS when the expected
-- version no longer matches, so D1 rolls the whole batch back. This table is
-- its target -- `matches` is 1 when the guarded row is still at the expected
-- version and 0 when it is not, and the CHECK constraint turns 0 into an error.
--
-- It holds no durable state of interest; it exists so that a version conflict
-- is expressible as a constraint violation rather than as a row count.
-- Keyed by (command_id, subject): one command may guard more than one row --
-- a page section mutation guards both the page and the section -- and each
-- guard needs its own fence row.
CREATE TABLE IF NOT EXISTS command_version_fence (
  command_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  matches INTEGER NOT NULL CHECK (matches = 1),
  checked_at TEXT NOT NULL,
  PRIMARY KEY (command_id, subject)
);
