-- Append-only migration. 0001-0006 are immutable.
--
-- A claim marked a job `running` durably, but nothing could ever clear it if the
-- attempt never finished: an isolate timeout, a crash, or a failed
-- failure-recording write left the row running forever, and every later retry of
-- that immutable command was refused as COMMAND_IN_PROGRESS.
--
-- Each running attempt now holds a lease. An unexpired lease still means "in
-- progress"; an expired one may be reclaimed, but only by the same command --
-- same id, type and digest -- so a stale lease never becomes a way to rebind an
-- id to different work. Completion requires the current lease token, so an
-- attempt that was superseded cannot write its result over the one that
-- replaced it.
ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_running_lease ON jobs(status, lease_expires_at);
