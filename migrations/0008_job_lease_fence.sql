-- Append-only migration. 0001-0007 are immutable.
--
-- A completion conditioned on the lease token only turns into a zero-row
-- statement when the lease has been lost. Zero rows is not an error, so it does
-- not abort the surrounding batch: a superseded attempt could still commit its
-- domain writes and leave the replacement job running.
--
-- D1 batches are SQL transactions -- "if a statement in the sequence fails...
-- it aborts or rolls back the entire sequence" -- so fencing needs a statement
-- that *fails* rather than one that matches nothing. This table is that
-- statement's target: the fence writes 1 when the caller still holds the lease
-- and 0 when it does not, and the CHECK constraint turns 0 into an error that
-- rolls the whole batch back.
--
-- It holds no durable state of interest; it exists so that losing a lease is
-- expressible as a constraint violation.
CREATE TABLE IF NOT EXISTS job_lease_fence (
  command_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  holds_lease INTEGER NOT NULL CHECK (holds_lease = 1),
  checked_at TEXT NOT NULL
);
