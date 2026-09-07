import { env } from 'cloudflare:workers';
import { uuid } from '../util';
import { CommandError } from '../core/errors';

/**
 * Every write to the `jobs` table.
 *
 * A commandId is bound to one immutable command by whoever claims it first, and
 * that binding is the basis of idempotency. It only holds if no handler writes
 * its own job row: a plain INSERT collides with the claim, and an upsert that
 * sets command_digest or command_type silently rebinds the id to different
 * work. Both happened before this module existed.
 *
 * Handlers therefore never touch `jobs` directly. They ask for a statement or
 * call a helper here, and a contract test fails the build if a handler writes to
 * `jobs` on its own.
 */

/** Columns a completion may set. Identity columns are deliberately absent. */
const COMPLETION_SET = `status=excluded.status,result_json=excluded.result_json,finished_at=excluded.finished_at,lease_token=NULL,lease_expires_at=NULL`;

/**
 * How long a running attempt holds its claim.
 *
 * This must exceed the longest a single attempt can possibly run, or a live
 * attempt could have its lease reclaimed underneath it. A Cloudflare Worker
 * invocation is bounded far below this: the platform terminates an invocation
 * long before fifteen minutes of wall clock, and the longest operation here is
 * a single provider fetch plus an R2 put inside one invocation. The margin is
 * deliberate -- reclaiming too early risks concurrent execution, while
 * reclaiming too late only delays recovery of an already-dead attempt.
 *
 * A superseded attempt cannot damage anything even if it does outlive its
 * lease: completion requires the current lease token, so its write is refused.
 */
export const LEASE_DURATION_MS = 15 * 60 * 1000;

/** The upper bound a single attempt is allowed to take. Asserted in tests. */
export const MAX_ATTEMPT_DURATION_MS = 5 * 60 * 1000;

const leaseExpiry = (from = Date.now()) => new Date(from + LEASE_DURATION_MS).toISOString();

/**
 * The exact statements this module issues.
 *
 * Exported so tests execute the same SQL the Worker does, against a real
 * migrated schema. A test that retypes these statements proves only that the
 * test is self-consistent -- removing a lease condition from the implementation
 * would then leave every test green.
 */
export const JOB_SQL = {
  claim:
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,command_digest,created_at,started_at,lease_token,lease_expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`,
  read:
    `SELECT id,status,result_json,command_digest,command_type,lease_token,lease_expires_at FROM jobs WHERE command_id=? LIMIT 1`,
  reopenFailed:
    `UPDATE jobs SET status='running',started_at=?,attempt_count=attempt_count+1,error_type=NULL,error_code=NULL,error_message=NULL,lease_token=?,lease_expires_at=?
     WHERE command_id=? AND command_digest=? AND command_type=? AND status='failed'`,
  reclaimExpired:
    `UPDATE jobs SET started_at=?,attempt_count=attempt_count+1,lease_token=?,lease_expires_at=?
     WHERE command_id=? AND command_digest=? AND command_type=? AND status='running'
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
  renewLease:
    `UPDATE jobs SET lease_expires_at=? WHERE command_id=? AND lease_token=? AND status='running'`,
  success:
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,result_json,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET ${COMPLETION_SET}
     WHERE jobs.lease_token IS NOT NULL AND jobs.lease_token = ?`,
  failure:
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,error_type,error_code,error_message,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(command_id) DO UPDATE SET
       status=excluded.status,error_type=excluded.error_type,error_code=excluded.error_code,error_message=excluded.error_message,finished_at=excluded.finished_at,lease_token=NULL,lease_expires_at=NULL
     WHERE jobs.lease_token IS NOT NULL AND jobs.lease_token = ?`
} as const;

/** The guarded completion, whose guard table is fixed by the caller. */
export const guardedSuccessSql = (table: 'news') =>
  `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,result_json,created_at,finished_at)
     SELECT ?,?,?,?,?,?,?,? FROM ${table} WHERE id=? AND content_type=? AND version=?
     ON CONFLICT(command_id) DO UPDATE SET ${COMPLETION_SET}
     WHERE jobs.lease_token IS NOT NULL AND jobs.lease_token = ?`;

/**
 * Bind this commandId to this command. First writer wins: DO NOTHING, never
 * DO UPDATE, so an id already claimed by another command is not taken over.
 */
/**
 * The lease this invocation holds, keyed by commandId.
 *
 * Held per invocation so handlers -- which complete inside their own D1 batch --
 * do not each have to thread the token through. A superseded attempt keeps its
 * old token here, which is exactly why its completion is refused.
 */
const activeLeases = new Map<string, string>();

export const currentLeaseToken = (commandId: string) => activeLeases.get(commandId) ?? '';
export const setLeaseToken = (commandId: string, leaseToken: string) => { activeLeases.set(commandId, leaseToken); };
export const clearLeaseToken = (commandId: string) => { activeLeases.delete(commandId); };

export async function claimCommand(commandId: string, command: string, digest: string) {
  const claimId = uuid();
  const leaseToken = uuid();
  const now = new Date().toISOString();
  await env.DB.prepare(JOB_SQL.claim).bind(claimId, commandId, command, 'running', 1, digest, now, now, leaseToken, leaseExpiry()).run();
  return { claimId, leaseToken, stored: await readJob(commandId) };
}

export async function readJob(commandId: string) {
  return await env.DB.prepare(JOB_SQL.read).bind(commandId).first<{ id: string; status: string; result_json: string | null; command_digest: string | null; command_type: string | null; lease_token: string | null; lease_expires_at: string | null }>();
}

/**
 * Re-open a failed job for a retry of the same command. Conditioned on the
 * stored digest and on the row still being failed, so it can neither rewrite an
 * identity binding nor start a second concurrent execution.
 */
export async function reopenFailedJob(commandId: string, command: string, digest: string) {
  const leaseToken = uuid();
  const now = new Date().toISOString();
  const outcome = await env.DB.prepare(JOB_SQL.reopenFailed).bind(now, leaseToken, leaseExpiry(), commandId, digest, command).run();

  if ((outcome as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_IN_PROGRESS', 'This command was picked up by another run. Wait for it to finish rather than running it a second time.', true, { commandId });
  }
  return leaseToken;
}

/**
 * Take over a running job whose lease has expired.
 *
 * Conditioned on the id, the command type, the digest *and* the lease still
 * being expired, in one atomic UPDATE. A different command can never reclaim,
 * however old the lease; and two reclaimers race on the same statement, so only
 * one wins.
 */
export async function reclaimExpiredLease(commandId: string, command: string, digest: string) {
  const leaseToken = uuid();
  const now = new Date();
  const outcome = await env.DB.prepare(JOB_SQL.reclaimExpired).bind(now.toISOString(), leaseToken, leaseExpiry(now.getTime()), commandId, digest, command, now.toISOString()).run();

  if ((outcome as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_IN_PROGRESS', 'This command is already executing under a live lease. Wait for it to finish rather than running it a second time.', true, { commandId });
  }
  return leaseToken;
}

/** Extend the lease of an attempt still in progress. */
export async function renewLease(commandId: string, leaseToken: string) {
  const outcome = await env.DB.prepare(JOB_SQL.renewLease).bind(leaseExpiry(), commandId, leaseToken).run();
  return (outcome as { meta?: { changes?: number } }).meta?.changes !== 0;
}

/**
 * The success statement, for handlers that complete inside a D1 batch so the
 * job lands in the same transaction as the mutation it records.
 */
export function successStatement(commandId: string, command: string, result: unknown, now = new Date().toISOString(), leaseToken = currentLeaseToken(commandId)) {
  return env.DB.prepare(JOB_SQL.success).bind(uuid(), commandId, command, 'success', 1, JSON.stringify(result), now, now, leaseToken);
}

/**
 * The success statement, conditioned on the mutation it records having actually
 * landed. Used where the job must not be written unless the guarded row moved
 * to the expected version.
 */
export function guardedSuccessStatement(
  commandId: string,
  command: string,
  result: unknown,
  guard: { table: 'news'; id: string; contentType: string; version: number },
  now = new Date().toISOString(),
  leaseToken = currentLeaseToken(commandId)
) {
  return env.DB.prepare(guardedSuccessSql(guard.table)).bind(uuid(), commandId, command, 'success', 1, JSON.stringify(result), now, now, guard.id, guard.contentType, guard.version, leaseToken);
}

export async function recordSuccess(commandId: string, command: string, result: unknown, leaseToken?: string) {
  await successStatement(commandId, command, result, new Date().toISOString(), leaseToken ?? currentLeaseToken(commandId)).run();
}

/**
 * Terminal failure. Every path that established `running` must reach this, or
 * the row stays running forever and every later retry of that immutable command
 * is refused as already in progress.
 */
export async function recordFailure(commandId: string, command: string, error: unknown, leaseToken = currentLeaseToken(commandId)) {
  const detail = error as { type?: string; code?: string };
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  const now = new Date().toISOString();
  await env.DB.prepare(JOB_SQL.failure).bind(uuid(), commandId, command, 'failed', 1, detail?.type || null, detail?.code || null, message, now, now, leaseToken).run();
}
