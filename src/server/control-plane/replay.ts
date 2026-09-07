import { CommandError } from '../core/errors';

export type StoredJob = {
  id: string;
  status: string;
  result_json: string | null;
  command_digest: string | null;
  command_type: string | null;
  lease_token?: string | null;
  lease_expires_at?: string | null;
} | null;

/** A running attempt still holds its claim only while its lease is unexpired. */
export function leaseIsLive(stored: NonNullable<StoredJob>, now = Date.now()) {
  if (!stored.lease_expires_at) return true; // no lease recorded: treat as live, never reclaim blindly
  const expiry = Date.parse(stored.lease_expires_at);
  return !Number.isFinite(expiry) || expiry > now;
}

export type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'replay'; result: unknown }
  | { kind: 'retry-after-failure' };

/**
 * What an existing row means for a command that has not yet been admitted.
 *
 * Read-only: this decides whether to answer immediately, refuse, or continue to
 * the admission checks. It never transitions anything, because a command that
 * has not passed schema, rule-version, authorization and preflight must not
 * leave a `running` row behind when one of those refuses it.
 */
export function evaluateExistingJob(commandId: string, commandType: string, submittedDigest: string, stored: StoredJob, now = Date.now()):
  | { kind: 'replay'; result: unknown }
  | { kind: 'proceed-new' }
  | { kind: 'proceed-after-failure' }
  | { kind: 'reclaim-expired-lease' } {
  if (!stored) return { kind: 'proceed-new' };

  if (!stored.command_digest) {
    throw new CommandError('CONFLICT', 'COMMAND_DIGEST_UNVERIFIABLE', 'This commandId is already bound to a job that predates command digests, so it cannot be confirmed to be the same command. Issue a new commandId.', false, { commandId });
  }
  if (stored.command_digest !== submittedDigest || (stored.command_type && stored.command_type !== commandType)) {
    throw new CommandError('CONFLICT', 'COMMAND_ID_REUSED', 'This commandId is already bound to a different command. A commandId identifies one immutable command and cannot be reused; issue a new commandId.', false, { commandId, storedCommand: stored.command_type, submittedCommand: commandType });
  }
  if (stored.status === 'success') {
    return { kind: 'replay', result: stored.result_json ? JSON.parse(stored.result_json) : null };
  }
  if (stored.status === 'running') {
    // The identity checks above have already run, so a stale lease can only ever
    // be reclaimed by the same command. A live one is a real execution.
    if (leaseIsLive(stored, now)) {
      throw new CommandError('CONFLICT', 'COMMAND_IN_PROGRESS', 'This command is already executing. Wait for it to finish rather than running it a second time.', true, { commandId });
    }
    return { kind: 'reclaim-expired-lease' };
  }
  return { kind: 'proceed-after-failure' };
}

/**
 * The state machine for a command id, applied to the authoritative stored row.
 *
 * A commandId is bound to one immutable command by whoever claims it first, and
 * that binding is never rewritten. Allowing a later submission to overwrite
 * command_digest would let two different commands share an id: the loser could
 * then replay the winner's result, and the winner's own retry would be refused
 * as reuse.
 *
 * Pure, so the Worker and the dispatch gate can apply the same rules and so
 * every branch is testable without a database.
 */
export function evaluateClaim(
  commandId: string,
  commandType: string,
  submittedDigest: string,
  stored: StoredJob,
  claimIdIfMine?: string
): ClaimOutcome {
  if (!stored) {
    throw new CommandError('FATAL_SYSTEM_ERROR', 'COMMAND_CLAIM_LOST', 'The command claim could not be read back.', true, { commandId });
  }

  // This process inserted the row, so it owns the binding and may execute.
  if (claimIdIfMine && stored.id === claimIdIfMine) return { kind: 'claimed' };

  // A row written before digests were recorded cannot be shown to describe this
  // command. Unverifiable is not a match.
  if (!stored.command_digest) {
    throw new CommandError(
      'CONFLICT',
      'COMMAND_DIGEST_UNVERIFIABLE',
      'This commandId is already bound to a job that predates command digests, so it cannot be confirmed to be the same command. Issue a new commandId.',
      false,
      { commandId }
    );
  }

  if (stored.command_digest !== submittedDigest || (stored.command_type && stored.command_type !== commandType)) {
    throw new CommandError(
      'CONFLICT',
      'COMMAND_ID_REUSED',
      'This commandId is already bound to a different command. A commandId identifies one immutable command and cannot be reused; issue a new commandId.',
      false,
      { commandId, storedCommand: stored.command_type, submittedCommand: commandType }
    );
  }

  // From here the submitted command is the same immutable command.
  if (stored.status === 'success') {
    return { kind: 'replay', result: stored.result_json ? JSON.parse(stored.result_json) : null };
  }

  if (stored.status === 'running') {
    throw new CommandError(
      'CONFLICT',
      'COMMAND_IN_PROGRESS',
      'This command is already executing. Wait for it to finish rather than running it a second time.',
      true,
      { commandId }
    );
  }

  // A previous attempt failed. The same command may be retried -- that is what
  // makes an immutable command safe to re-send -- and the identity binding
  // stays exactly as the first writer set it.
  return { kind: 'retry-after-failure' };
}
