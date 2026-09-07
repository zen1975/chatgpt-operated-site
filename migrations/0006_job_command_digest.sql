-- Append-only migration. 0001-0005 are immutable.
--
-- Idempotency was keyed by command_id alone, so reusing a successful id for a
-- different operation returned the old result and silently skipped the new
-- mutation. The canonical digest of the immutable command is recorded with the
-- job so a replay can be required to match the command it is replaying.
--
-- Nullable on purpose: jobs written before this migration have no digest, and
-- those are treated as unverifiable (fail closed) rather than assumed to match.
ALTER TABLE jobs ADD COLUMN command_digest TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_command_id_digest ON jobs(command_id, command_digest);
