import { CommandError } from '../core/errors';

export type PriorJob = {
  status: string;
  result_json: string | null;
  command_digest: string | null;
} | null;

/**
 * Decide whether a submitted command may be answered with a stored result.
 *
 * Idempotency is keyed by the *complete immutable command*, not by its id. An
 * id identifies a request; the digest identifies what was requested. Keying on
 * the id alone means that reusing a successful id for a different operation
 * returns the old result and silently skips the new mutation, while the caller
 * is told the command succeeded.
 *
 * Pure and exported so both the Worker and the dispatch gate can enforce the
 * same rule, and so it can be tested without a database.
 */
export function evaluateReplay(commandId: string, submittedDigest: string, prior: PriorJob) {
  if (!prior || prior.status !== 'success') return { replay: false as const };

  // A job recorded before digests were stored cannot be shown to describe this
  // command. Unverifiable is not a match.
  if (!prior.command_digest) {
    throw new CommandError(
      'CONFLICT',
      'COMMAND_DIGEST_UNVERIFIABLE',
      'This commandId already succeeded, but the stored job predates command digests, so it cannot be confirmed to be the same command. Issue a new commandId.',
      false,
      { commandId }
    );
  }

  if (prior.command_digest !== submittedDigest) {
    throw new CommandError(
      'CONFLICT',
      'COMMAND_ID_REUSED',
      'This commandId already succeeded for a different command. A commandId identifies one immutable command and cannot be reused; issue a new commandId.',
      false,
      { commandId, storedDigest: prior.command_digest, submittedDigest }
    );
  }

  return { replay: true as const, result: prior.result_json ? JSON.parse(prior.result_json) : null };
}
