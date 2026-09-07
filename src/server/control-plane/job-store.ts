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
const COMPLETION_SET = `status=excluded.status,result_json=excluded.result_json,finished_at=excluded.finished_at`;

/**
 * Bind this commandId to this command. First writer wins: DO NOTHING, never
 * DO UPDATE, so an id already claimed by another command is not taken over.
 */
export async function claimCommand(commandId: string, command: string, digest: string) {
  const claimId = uuid();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,command_digest,created_at,started_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`
  ).bind(claimId, commandId, command, 'running', 1, digest, now, now).run();
  return { claimId, stored: await readJob(commandId) };
}

export async function readJob(commandId: string) {
  return await env.DB.prepare(
    `SELECT id,status,result_json,command_digest,command_type FROM jobs WHERE command_id=? LIMIT 1`
  ).bind(commandId).first<{ id: string; status: string; result_json: string | null; command_digest: string | null; command_type: string | null }>();
}

/**
 * Re-open a failed job for a retry of the same command. Conditioned on the
 * stored digest and on the row still being failed, so it can neither rewrite an
 * identity binding nor start a second concurrent execution.
 */
export async function reopenFailedJob(commandId: string, digest: string) {
  const now = new Date().toISOString();
  const outcome = await env.DB.prepare(
    `UPDATE jobs SET status='running',started_at=?,attempt_count=attempt_count+1,error_type=NULL,error_code=NULL,error_message=NULL
     WHERE command_id=? AND command_digest=? AND status='failed'`
  ).bind(now, commandId, digest).run();

  if ((outcome as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_IN_PROGRESS', 'This command was picked up by another run. Wait for it to finish rather than running it a second time.', true, { commandId });
  }
}

/**
 * The success statement, for handlers that complete inside a D1 batch so the
 * job lands in the same transaction as the mutation it records.
 */
export function successStatement(commandId: string, command: string, result: unknown, now = new Date().toISOString()) {
  return env.DB.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,result_json,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET ${COMPLETION_SET}`
  ).bind(uuid(), commandId, command, 'success', 1, JSON.stringify(result), now, now);
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
  now = new Date().toISOString()
) {
  return env.DB.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,result_json,created_at,finished_at)
     SELECT ?,?,?,?,?,?,?,? FROM ${guard.table} WHERE id=? AND content_type=? AND version=?
     ON CONFLICT(command_id) DO UPDATE SET ${COMPLETION_SET}`
  ).bind(uuid(), commandId, command, 'success', 1, JSON.stringify(result), now, now, guard.id, guard.contentType, guard.version);
}

export async function recordSuccess(commandId: string, command: string, result: unknown) {
  await successStatement(commandId, command, result).run();
}

/**
 * Terminal failure. Every path that established `running` must reach this, or
 * the row stays running forever and every later retry of that immutable command
 * is refused as already in progress.
 */
export async function recordFailure(commandId: string, command: string, error: unknown) {
  const detail = error as { type?: string; code?: string };
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,error_type,error_code,error_message,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(command_id) DO UPDATE SET
       status=excluded.status,error_type=excluded.error_type,error_code=excluded.error_code,error_message=excluded.error_message,finished_at=excluded.finished_at`
  ).bind(uuid(), commandId, command, 'failed', 1, detail?.type || null, detail?.code || null, message, now, now).run();
}
