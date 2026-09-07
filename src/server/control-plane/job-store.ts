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
/**
 * Who is executing this command, and under which lease.
 *
 * Passed explicitly from the claim all the way through the handlers to the
 * completion write. It used to live in a module-global map keyed by commandId,
 * which is wrong in exactly the case leases exist for: an attempt that outlives
 * its lease and the retry that reclaimed it can run in the same isolate, and
 * the retry would overwrite the map entry -- handing the superseded attempt the
 * retry's token, and letting its `finally` delete the retry's lease. A token
 * recovered by looking up a commandId is not proof of ownership.
 */
export type CommandExecution = {
  readonly commandId: string;
  readonly commandType: string;
  readonly commandDigest: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
};

export const JOB_SQL = {
  /**
   * Proves the caller still owns the lease, as a statement that *fails* when it
   * does not.
   *
   * A completion conditioned on the lease token merely matches zero rows when
   * the lease is gone, and zero rows is not an error, so it cannot abort a
   * batch. This writes 1 when the lease is held and 0 when it is not, and
   * job_lease_fence.holds_lease has a CHECK constraint that rejects 0 -- which
   * D1 surfaces as a failed statement, rolling back the entire batch.
   */
  fence:
    `INSERT INTO job_lease_fence (command_id, lease_token, holds_lease, checked_at)
     VALUES (?, ?, (SELECT COUNT(*) FROM jobs WHERE command_id=? AND lease_token=? AND status='running'), ?)
     ON CONFLICT(command_id) DO UPDATE SET lease_token=excluded.lease_token, holds_lease=excluded.holds_lease, checked_at=excluded.checked_at`,
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
  /**
   * Proves the guarded row is still at the expected version, as a statement
   * that FAILS when it is not.
   *
   * `<GUARD>` is substituted from a fixed map below -- never from a payload --
   * so no caller can influence the table or the predicate.
   */
  versionFence:
    `INSERT INTO command_version_fence (command_id, subject, expected_version, matches, checked_at)
     VALUES (?, ?, ?, (SELECT COUNT(*) FROM <GUARD>), ?)
     ON CONFLICT(command_id, subject) DO UPDATE SET expected_version=excluded.expected_version, matches=excluded.matches, checked_at=excluded.checked_at`,
  failure:
    `INSERT INTO jobs (id,command_id,command_type,status,attempt_count,error_type,error_code,error_message,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(command_id) DO UPDATE SET
       status=excluded.status,error_type=excluded.error_type,error_code=excluded.error_code,error_message=excluded.error_message,finished_at=excluded.finished_at,lease_token=NULL,lease_expires_at=NULL
     WHERE jobs.lease_token IS NOT NULL AND jobs.lease_token = ?`
} as const;

/**
 * The rows an optimistic version guard may be taken against.
 *
 * A closed map, so the table and the predicate are always literals from this
 * file. Adding a version-guarded mutation means adding an entry here, which is
 * also what makes the set enumerable by the contract tests.
 */
export const VERSION_GUARDS = {
  news: { table: 'news', predicate: 'id=? AND content_type=? AND version=?', arity: 3 },
  products: { table: 'products', predicate: 'id=? AND version=?', arity: 2 },
  pages: { table: 'pages', predicate: 'id=? AND version=?', arity: 2 },
  page_sections: { table: 'page_sections', predicate: 'id=? AND version=?', arity: 2 }
} as const;

export type VersionGuardSubject = keyof typeof VERSION_GUARDS;

export type VersionGuard = {
  readonly subject: VersionGuardSubject;
  readonly expectedVersion: number;
  /** Values for the guard's predicate, in order. */
  readonly keys: readonly (string | number)[];
};

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
export async function claimCommand(commandId: string, command: string, digest: string) {
  const claimId = uuid();
  const leaseToken = uuid();
  const now = new Date().toISOString();
  const leaseExpiresAt = leaseExpiry();
  await env.DB.prepare(JOB_SQL.claim).bind(claimId, commandId, command, 'running', 1, digest, now, now, leaseToken, leaseExpiresAt).run();
  const execution: CommandExecution = { commandId, commandType: command, commandDigest: digest, leaseToken, leaseExpiresAt };
  return { claimId, execution, stored: await readJob(commandId) };
}

export async function readJob(commandId: string) {
  return await env.DB.prepare(JOB_SQL.read).bind(commandId).first<{ id: string; status: string; result_json: string | null; command_digest: string | null; command_type: string | null; lease_token: string | null; lease_expires_at: string | null }>();
}

/**
 * Re-open a failed job for a retry of the same command. Conditioned on the
 * stored digest and on the row still being failed, so it can neither rewrite an
 * identity binding nor start a second concurrent execution.
 */
export async function reopenFailedJob(commandId: string, command: string, digest: string): Promise<CommandExecution> {
  const leaseToken = uuid();
  const now = new Date().toISOString();
  const leaseExpiresAt = leaseExpiry();
  const outcome = await env.DB.prepare(JOB_SQL.reopenFailed).bind(now, leaseToken, leaseExpiresAt, commandId, digest, command).run();

  if ((outcome as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_IN_PROGRESS', 'This command was picked up by another run. Wait for it to finish rather than running it a second time.', true, { commandId });
  }
  return { commandId, commandType: command, commandDigest: digest, leaseToken, leaseExpiresAt };
}

/**
 * Take over a running job whose lease has expired.
 *
 * Conditioned on the id, the command type, the digest *and* the lease still
 * being expired, in one atomic UPDATE. A different command can never reclaim,
 * however old the lease; and two reclaimers race on the same statement, so only
 * one wins.
 */
export async function reclaimExpiredLease(commandId: string, command: string, digest: string): Promise<CommandExecution> {
  const leaseToken = uuid();
  const now = new Date();
  const leaseExpiresAt = leaseExpiry(now.getTime());
  const outcome = await env.DB.prepare(JOB_SQL.reclaimExpired).bind(now.toISOString(), leaseToken, leaseExpiresAt, commandId, digest, command, now.toISOString()).run();

  if ((outcome as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_IN_PROGRESS', 'This command is already executing under a live lease. Wait for it to finish rather than running it a second time.', true, { commandId });
  }
  return { commandId, commandType: command, commandDigest: digest, leaseToken, leaseExpiresAt };
}

/** Extend the lease of an attempt still in progress. */
export async function renewLease(execution: CommandExecution): Promise<CommandExecution> {
  const leaseExpiresAt = leaseExpiry();
  const outcome = await env.DB.prepare(JOB_SQL.renewLease).bind(leaseExpiresAt, execution.commandId, execution.leaseToken).run();
  if ((outcome as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_LEASE_LOST', 'This attempt no longer holds the command lease; another attempt has taken over.', false, { commandId: execution.commandId });
  }
  return { ...execution, leaseExpiresAt };
}

/**
 * The success statement, for handlers that complete inside a D1 batch so the
 * job lands in the same transaction as the mutation it records.
 */
/** The lease fence, as a statement, for the head of a mutation batch. */
export function leaseFenceStatement(execution: CommandExecution, now = new Date().toISOString()) {
  return env.DB.prepare(JOB_SQL.fence).bind(execution.commandId, execution.leaseToken, execution.commandId, execution.leaseToken, now);
}

/**
 * The version fence. Fails -- and so rolls the batch back -- when the guarded
 * row is no longer at the expected version.
 */
export function versionFenceStatement(execution: CommandExecution, guard: VersionGuard, now = new Date().toISOString()) {
  const definition = VERSION_GUARDS[guard.subject];
  if (!definition) throw new CommandError('FATAL_SYSTEM_ERROR', 'VERSION_GUARD_UNKNOWN', `No version guard is registered for ${guard.subject}.`);
  if (guard.keys.length !== definition.arity) {
    throw new CommandError('FATAL_SYSTEM_ERROR', 'VERSION_GUARD_ARITY', `The ${guard.subject} version guard expects ${definition.arity} keys.`);
  }
  const sql = JOB_SQL.versionFence.replace('<GUARD>', `${definition.table} WHERE ${definition.predicate}`);
  return env.DB.prepare(sql).bind(execution.commandId, guard.subject, guard.expectedVersion, ...guard.keys, now);
}

/**
 * A statement paired with the name its result is looked up by.
 *
 * Results are never read by position. Batches are assembled from several
 * sources -- fences, optional intake registration, the domain mutation, a
 * revision, the completion -- so a fixed index silently means something
 * different as soon as any of those changes length. That already happened
 * twice: adding the lease fence shifted the guarded update from index 0 to 1,
 * and adding intake registration shifted it again.
 */
export type NamedStatement = { readonly name: string; readonly statement: D1PreparedStatement };

export const named = (name: string, statement: D1PreparedStatement): NamedStatement => ({ name, statement });

/** Batch results, addressable only by name. */
export type NamedResults = {
  get(name: string): { meta?: { changes?: number } } | undefined;
  changes(name: string): number | undefined;
  names(): string[];
};

/**
 * Run a mutation batch fenced by the caller's lease and, where the mutation is
 * version-guarded, by the expected version.
 *
 * Order is fixed and meaningful:
 *   lease fence -> version fence -> caller statements (intake, mutation,
 *   revision, the sole success transition)
 *
 * Both fences fail rather than match nothing, so a lost lease or an advanced
 * version aborts the sequence and D1 rolls back everything: no intake
 * registration, no attachment, no revision, no success.
 */
export async function fencedBatch(
  execution: CommandExecution,
  statements: NamedStatement[],
  options: { versionGuards?: VersionGuard[] } = {}
): Promise<NamedResults> {
  const now = new Date().toISOString();
  const prefix: NamedStatement[] = [named('lease-fence', leaseFenceStatement(execution, now))];
  for (const guard of options.versionGuards ?? []) {
    prefix.push(named(`version-fence:${guard.subject}`, versionFenceStatement(execution, guard, now)));
  }

  const all = [...prefix, ...statements];
  let results: unknown[];
  try {
    results = await env.DB.batch(all.map((entry) => entry.statement));
  } catch (error) {
    if (isLeaseFenceViolation(error)) {
      throw new CommandError('CONFLICT', 'COMMAND_LEASE_LOST', 'This attempt no longer holds the command lease; another attempt has taken over, so its changes were not applied.', false, { commandId: execution.commandId });
    }
    if (isVersionFenceViolation(error)) {
      throw new CommandError('CONFLICT', 'VERSION_CONFLICT', 'The target changed while this command was running, so none of its changes were applied.', false, { commandId: execution.commandId, guards: (options.versionGuards ?? []).map((guard) => ({ subject: guard.subject, expectedVersion: guard.expectedVersion })) });
    }
    throw error;
  }

  const byName = new Map<string, { meta?: { changes?: number } }>();
  all.forEach((entry, index) => byName.set(entry.name, results[index] as { meta?: { changes?: number } }));

  return {
    get: (name) => byName.get(name),
    changes: (name) => byName.get(name)?.meta?.changes,
    names: () => [...byName.keys()]
  };
}

const isLeaseFenceViolation = (error: unknown) => /holds_lease|job_lease_fence/i.test(error instanceof Error ? error.message : String(error));
const isVersionFenceViolation = (error: unknown) => /\bmatches\b|command_version_fence/i.test(error instanceof Error ? error.message : String(error));

/**
 * The success statement. Carries the caller's own lease token -- never one
 * recovered by looking up the commandId -- so a superseded attempt cannot
 * complete as the current owner.
 */
export function successStatement(execution: CommandExecution, result: unknown, now = new Date().toISOString()) {
  return env.DB.prepare(JOB_SQL.success).bind(
    uuid(), execution.commandId, execution.commandType, 'success', 1, JSON.stringify(result), now, now, execution.leaseToken
  );
}

/**
 * The success statement, additionally conditioned on the mutation it records
 * having landed at the expected version.
 */
export function guardedSuccessStatement(
  execution: CommandExecution,
  result: unknown,
  guard: { table: 'news'; id: string; contentType: string; version: number },
  now = new Date().toISOString()
) {
  return env.DB.prepare(guardedSuccessSql(guard.table)).bind(
    uuid(), execution.commandId, execution.commandType, 'success', 1, JSON.stringify(result), now, now,
    guard.id, guard.contentType, guard.version, execution.leaseToken
  );
}

/** Terminal success, for handlers that complete outside a batch. */
export async function recordSuccess(execution: CommandExecution, result: unknown) {
  const outcome = await successStatement(execution, result).run();
  // Same rule as inside a batch: the completion must affect exactly the one row
  // this lease owns.
  assertOwnedRowAffected(execution, { get: () => outcome, changes: () => outcome.meta?.changes, names: () => [SUCCESS_STATEMENT_NAME] });
}

/**
 * The final transition must affect exactly the one row this lease owns. Zero
 * rows means the lease was lost between the fence and the completion.
 */
export function assertOwnedRowAffected(execution: CommandExecution, results: NamedResults, name = 'success') {
  const changes = results.changes(name);
  if (changes === 0) {
    throw new CommandError('CONFLICT', 'COMMAND_LEASE_LOST', 'This attempt no longer holds the command lease, so its completion was not recorded.', false, { commandId: execution.commandId });
  }
  if (typeof changes === 'number' && changes > 1) {
    throw new CommandError('FATAL_SYSTEM_ERROR', 'COMMAND_COMPLETION_AMBIGUOUS', 'The completion affected more than one job row.', false, { commandId: execution.commandId, changes });
  }
}

/** Name used for the sole success transition in every fenced batch. */
export const SUCCESS_STATEMENT_NAME = 'success';

/**
 * Terminal failure, under this attempt's own lease. A superseded attempt's
 * failure is not recorded, because the job no longer belongs to it.
 */
export async function recordFailure(execution: CommandExecution, error: unknown) {
  const detail = error as { type?: string; code?: string };
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  const now = new Date().toISOString();
  await env.DB.prepare(JOB_SQL.failure).bind(
    uuid(), execution.commandId, execution.commandType, 'failed', 1, detail?.type || null, detail?.code || null, message, now, now, execution.leaseToken
  ).run();
}
