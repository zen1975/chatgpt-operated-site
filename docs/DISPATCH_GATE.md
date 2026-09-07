# The GitHub Actions Dispatch Gate

This is the "GitHub Actions validation / dispatch" stage of the control path:

```text
Client
  -> ChatGPT
  -> immutable Command
  -> GitHub Actions validation / dispatch   <-- this document
  -> Cloudflare Worker controlled mutation
  -> D1 / R2 source of truth
  -> Astro website / projections
```

It is the only supported way an operator command reaches the Worker.

## Why the gate exists

The Worker already validates everything it receives, so the gate is not there to
be the Worker's only line of defence. It exists for three reasons the Worker
cannot cover on its own:

1. **Authenticated checks the ChatGPT client cannot perform.** `AGENTS.md`
   assigns Asset Intake readiness to this gate precisely because the client has
   no credential to run it.
2. **Failing before mutation rather than during it.** A stale rule version or a
   stale `expectedVersion` is caught while nothing has been written.
3. **A record of what was requested, by whom.** The workflow run is the audit
   trail.

## The gates

They run in a fixed order and every one fails closed. Nothing is dispatched
unless all of them pass.

| # | Gate | Network | What stops here |
| --- | --- | --- | --- |
| 1 | Schema | none | Envelope or payload that does not match the current Zod contracts in `src/server` |
| 2 | Rule version | none | `context.ruleVersion` differing from this installation's rule version |
| 3 | Target site | none | A command written for a different installation |
| 4 | Remote identity | authenticated read | An endpoint that is not the installation the command names |
| 5 | Asset Intake readiness | authenticated read | A command carrying an intake source whose provider is not usable |
| 6 | Preflight | authenticated read | Missing target, or `expectedVersion` no longer matching current state |

Gates 1 to 3 are purely local: they need no credentials and no network, so a
misaddressed or malformed command never reaches the installation at all.

### Gate 3: the command must name this installation

`context.targetSite` is **required by the envelope schema itself**, so an absent
or empty value fails at gate 1. Gate 3 adds the part the schema cannot know:
the value must equal `site.id` in `config/site-profile.json`.

`commandId` is likewise constrained by one authoritative schema
(`CommandId` in `src/server/command-schema.ts`): 8–200 characters of
`A-Za-z0-9._:-`. The envelope and the command lookup route share it, so an id
the envelope admits is always one the lookup can address. Ids containing
Unicode, whitespace or `/` are rejected at gate 1, before any request.

The Worker does not check this field, and the endpoint comes from this
repository's own configuration — so without this gate, a command prepared for
one customer, run from the wrong repository or workflow, would be applied to
whichever site the workflow points at.

### Gate 4: two questions, not one

`context.requiresAssetIntake` answers a contract question, and readiness answers
an infrastructure one. They are deliberately not the same boolean.

**Is the command image-bearing?** A property of the command itself. The
operating contract requires the flag on every image-bearing operation, and a
command naming an existing canonical `assetId` is still one of those. Answering
this with "does a provider need to be ready?" rejected every such command before
it reached preflight.

| Image-bearing | Not image-bearing |
| --- | --- |
| `attach_asset`, `replace_asset`, `attach_product_asset`, `replace_product_asset`, `replace_page_section_asset`, `replace_page_section_item_asset`, `import_wordpress_asset` | everything else, including `remove_product_asset` and `reorder_product_assets`, which rearrange assets already in place |

The flag is required on the first set (`ASSET_INTAKE_FLAG_MISSING`) and refused
on the second (`ASSET_INTAKE_FLAG_UNEXPECTED`).

**Must a provider be ready?** Only when the asset actually arrives through one.
Read from the validated payload:

| Command | Intake source | Provider from |
| --- | --- | --- |
| `import_wordpress_asset` | always | the command itself (`wordpress`) |
| `replace_asset`, `replace_product_asset`, `replace_page_section_asset` | only when `payload.reference` is present | `payload.reference.provider` |
| `attach_asset`, `attach_product_asset`, `replace_page_section_item_asset` | never — canonical `assetId` only | not applicable |

A reference-bearing command may instead carry a canonical `assetId` that is
already inside the Asset Engine. That command is still image-bearing and still
requires the flag; it simply needs no provider, so no readiness check runs.

**Readiness is provider-specific.** `/api/control/readiness/asset-intake/`
evaluates Google Drive credentials and the Drive intake folder — nothing else.
Treating its verdict as evidence for another provider would assert something the
application never checked, so only `google_drive` has a canonical mechanism
here. Any other provider fails closed with
`ASSET_INTAKE_READINESS_UNSUPPORTED`. Adding a provider means implementing a
real readiness check for it and registering it, never reusing Drive's.

### The preflight receipt

Gate 3 does more than check state. `/api/control/preflight` returns a receipt —
`commandDigest` plus `contractVersion` — which the gate binds into
`context.preflight` before dispatching.

The Worker re-derives the digest and rejects the command if it does not match
(`COMMAND_DIGEST_MISMATCH`), or if the contract has moved on since the receipt
was issued (`COMMAND_CONTRACT_DRIFT`). A command therefore cannot be altered
between attestation and execution.

`commandDigest` is computed over the envelope with `context.preflight` removed,
so attaching the receipt cannot change the digest it attests.

Some commands — currently `import_wordpress_asset` — are refused by the Worker
outright without a receipt (`COMMAND_PREFLIGHT_REQUIRED`).

## Asset intake is a reference, never bytes

An externally dispatched command carries a **bounded provider reference or a
canonical asset id**. It never carries image bytes. `AssetIntakeDescriptor` puts
it plainly in the Core boundary: *"Binary transfer is intentionally not part of
this descriptor... GitHub command JSON must never become a routine binary
transport."*

The supported public intake paths are therefore:

| Command | Carries |
| --- | --- |
| `replace_asset`, `replace_product_asset`, `replace_page_section_asset` | `payload.reference` — a provider plus a provider asset id — or a canonical `assetId` already in the Asset Engine |
| `attach_asset`, `attach_product_asset`, `replace_page_section_item_asset` | a canonical `assetId` only. These schemas reject a `reference` outright, so an asset must already be in the Asset Engine — bring it in with a replace command or a WordPress import first |
| `import_wordpress_asset` | a WordPress media reference (source URL and id) |

In each case the Worker resolves the reference and fetches the bytes itself,
inside the intake layer, where readiness and credentials live.

`create_asset` used to be advertised in the envelope enum, but its payload
required an in-memory `Uint8Array`. JSON can neither construct nor preserve
that, so no operator could ever have sent one: it was an advertised command with
no reachable caller. It has been removed from the envelope, the payload schema
map, the authorization scopes, the Worker branch and the published schema. The
intake descriptor is still published — adapters and installers consume it — but
as intake-layer documentation, not a command payload.

The command matrix test enforces this: every advertised command must survive a
JSON round trip, so a payload that cannot be expressed in JSON fails the build
rather than shipping as a contract nobody can use.

## Recovering a lost dispatch response

Commands are immutable and idempotent, but a dispatch can commit its mutation
and still lose the response -- a dropped connection, a cancelled run. Re-running
the command then meets two difficulties: the mutation already happened, so its
`expectedVersion` is now legitimately stale, and if the contract has moved on
since, its `ruleVersion` is stale too. Both would be reported as conflicts for a
command that in fact succeeded.

### Identification is separate from admission

The gate does two different jobs, in order.

**Step 1 -- identify.** Validate only what is needed to address the command
safely: a JSON object with a valid `CommandId`, and a `targetSite` naming this
installation. Compute the canonical digest, then ask
`GET /api/control/commands/{commandId}` (scope `command:read`) whether this
command already completed.

**Step 2 -- admit, only if this is new work.** The full current schema, rule
version, Asset Intake readiness and preflight. These rules describe how a *new*
command is admitted; applying them to a completed one would strand it.

### Idempotency is bound to the command, not the id

An id identifies a request; the **digest identifies what was requested**. Keying
idempotency on the id alone means that accidentally reusing a successful id for
a different operation returns the old result and silently skips the mutation
just requested, while reporting success.

`migrations/0006_job_command_digest.sql` records the canonical digest with each
job. The binding is made by whoever claims the id **first**, and is never
rewritten:

- the claim is an insert with **conflict-ignore** semantics; the row is then
  read back and the **stored** value decides what happens
- success and failure recording update status and result fields only. No write
  path may touch `command_digest` or `command_type`
- **every** write to `jobs` goes through `src/server/control-plane/job-store.ts`.
  A handler that writes its own row either collides with the claim or rebinds
  the id, and both happened before the store existed; a contract test fails the
  build if any handler writes to `jobs` directly

### The claim lifecycle

Nothing writes to `jobs` until the command has passed every check that could
refuse it. Ordering is the guarantee, and it is asserted by a test:

```text
envelope -> authorization -> site identity -> digest
  -> read-only idempotency check      (may answer a completed replay)
  -> admission: preflight binding, rule version, payload schema
  -> atomic transition to running     (claim, or failed -> running)
  -> handler                          (every exception recorded as failed)
```

An admission check that refuses a command must not leave a `running` row: that
row would make every later retry of that immutable command fail as
`COMMAND_IN_PROGRESS` forever. Once `running` is established, every exit is
terminal -- success or failed -- so the only `running` row is an execution
actually in flight.

### Leases, for attempts that never finish

An exception can be recorded. A terminated isolate cannot. Without a lease, a
crash mid-attempt would strand the command exactly as an unrecorded failure
would, so each running attempt holds one
(`migrations/0007_job_lease.sql`).

| Lease state | Outcome |
| --- | --- |
| unexpired | `COMMAND_IN_PROGRESS` -- a real execution is under way |
| expired, same id + type + digest | reclaimed by one atomic conditional update |
| expired, different type or digest | `COMMAND_ID_REUSED` -- however old the lease |
| no lease recorded | treated as live; never reclaimed blindly |

Two racing reclaimers contend on the same statement, so only one wins.

**The lease is carried, never looked up.** Claiming or reclaiming returns an
immutable execution context -- command id, type, digest, lease token and expiry
-- threaded explicitly through `executeCommand`, every handler and every
completion write. Keying request state by command id would fail in exactly the
case leases exist for: an attempt that outlives its lease and the retry that
reclaimed it can run in the same isolate, and the retry would overwrite that
entry, handing the superseded attempt the retry's token and letting its cleanup
delete the retry's lease.

**The domain mutation itself is fenced.** A completion conditioned on the lease
token only matches zero rows when the lease is gone, and zero rows is not an
error, so it cannot abort anything: a superseded attempt could still commit its
content and leave the replacement job running. D1 batches are SQL transactions
-- "if a statement in the sequence fails... it aborts or rolls back the entire
sequence" -- so the fence is a statement that *fails*. It writes 1 into
`job_lease_fence.holds_lease` when the caller still holds the lease and 0 when
it does not, and a CHECK constraint rejects 0.

### The version guard is a fence too

An optimistic version check used to be an affected-row count read after the
batch. That is not a safety boundary: a guarded UPDATE matching zero rows is not
an error, so D1 commits the revision, the projection and the success transition
and the check only discovers afterwards that the mutation it guarded never
applied.

`migrations/0009` adds `command_version_fence`, the same shape as the lease
fence: `matches` is 1 when the guarded row is still at the expected version and
0 when it is not, and a CHECK constraint rejects 0. Every optimistic-version
mutation -- content, product, page, and page sections -- supplies its guard to
`fencedBatch`, which emits one fence per guard. The table and predicate come
from a closed map in `job-store.ts`, never from a payload.

The batch order is therefore:

```text
lease fence -> version fence(s) -> intake registration -> domain mutation
  -> revision -> the sole success transition
```

### Results are addressed by name

Batch results are never read by position. A batch is assembled from several
sources -- fences, optional intake registration, the mutation, a revision, the
completion -- so a fixed index silently means something different as soon as any
of them changes length. That happened twice: adding the lease fence shifted the
guarded update from index 0 to 1, and adding intake registration shifted it
again, at which point an intake statement's one-row result could be mistaken for
a successful version update.

`fencedBatch` takes `NamedStatement`s -- whose `statement` is a real
`D1PreparedStatement`, not `unknown` -- and returns results addressable only by
name.

That typing matters. `tsconfig` referenced `@cloudflare/workers-types`, which is
not installed, so every binding resolved to `any` and a raw statement could be
passed where a named one was required while the build stayed green. The runtime
surface this project uses is now declared in `src/env.d.ts`, which is what lets
the compiler reject the mistake instead of the database receiving `undefined`. The type has no index signature, so positional access does not compile,
and contract tests fail the build on any `batch[n]`/`results[n]` pattern or on a
cast that would reopen one.

Every mutation batch runs through `fencedBatch`, which puts the fences
first. A batch whose lease has been lost fails on its first statement, and the
whole sequence rolls back: no content, taxonomy, asset, product, page, revision
or projection write from a superseded attempt ever commits. Handlers additionally
check affected rows explicitly, and the final success transition must affect
exactly the one job row that lease owns.

R2 objects are content-addressed, so a repeated write is harmless -- but their
D1 registration is fenced like everything else.

### A prepared asset is validated by its preparation, not by a lookup

An asset named by canonical id must already exist, and is verified against D1.
An asset arriving as a provider reference is registered by the command's own
fenced batch, so querying D1 for it beforehand looks for a row that has not been
written yet -- which made every first-time provider-backed replacement fail
while orphaning the object it had just uploaded.

The two paths are therefore separate in `replace_asset`,
`replace_product_asset` and `replace_page_section_asset`: the canonical path
keeps its existence check (`ASSET_NOT_FOUND`, `PAGE_ASSET_UNUSABLE`), and the
prepared path uses the validated preparation result and lets the registration
prove itself by landing in the same batch.

### Only the outermost execution finalizes a job

Asset intake is split in two. **Preparation** fetches the bytes, validates them,
derives the canonical asset id and key, and performs the content-addressed R2
put; it returns the D1 statements that register the asset and completes nothing.
The **outer command** puts those statements into its own final fenced batch,
alongside the attachment or replacement, the revision, and the single success
transition.

That split is not tidiness. When intake finalized the shared job itself, a
provider-backed `replace_asset` marked its own command successful and cleared
its lease before the replacement had run: the parent's batch then failed its own
fence, and the command was reported as completed although nothing was replaced.
`import_wordpress_asset` is the one case where intake *is* the outer command, so
it has an explicit root-command entry point that performs the one finalization.

A contract test fails the build if any file outside root command orchestration
completes a job, and if preparation ever commits a batch or writes a success.

### Orphaned objects are preferred to unsafe deletion

There is no compensating R2 delete in the command path. A content-addressed key
is shared state, not something one attempt owns: a stale attempt deleting it can
remove the object a concurrent retry has just written and is about to reference,
leaving a committed record pointing at nothing.

Because registration now travels in the outer command's fenced batch, a failed
command commits no asset row at all. The worst outcome is an unreferenced
content-addressed object -- inert, and reclaimable by a separate
garbage-collection pass that can apply a grace window and prove no D1 reference
and no live execution uses the key. Neither can be proven from inside a failing
command, which is why it is not attempted there.

The lease outlasts any single attempt by design: `LEASE_DURATION_MS` is fifteen
minutes against a supported attempt bound of five, and a Worker invocation is
bounded far below either. Reclaiming too early risks concurrent execution;
reclaiming too late only delays recovery of an attempt that is already dead.

### A reclaimed attempt must not repeat a side effect

Recovery is only safe if re-running is safe. Two mechanisms carry that:

- **D1 work** keeps the domain mutation and the job completion in one batch, so
  an interrupted attempt leaves neither behind, and the mutations are guarded on
  their natural keys so a re-run after a committed mutation applies nothing a
  second time.
- **R2 and provider work** is content-addressed: the asset id and the R2 key are
  derived from the SHA-256 of the bytes, and the D1 row is inserted only when no
  row for that content exists. A repeated attempt writes the same bytes to the
  same key.

Termination before the mutation, during it, and after it but before the
completion write are each tested against a real migrated database. In every case
a retry produces one logical mutation and one stable result.

| Stored row | Submitted command | Outcome |
| --- | --- | --- |
| none (this claim won) | -- | executes |
| digest and type match, `success` | same immutable command | replayed; the original result is returned, no second mutation |
| digest and type match, `running` | same immutable command | `COMMAND_IN_PROGRESS` -- retryable; never executed concurrently |
| digest and type match, `failed` | same immutable command | retried, re-opening the row only while it is still failed, so two retries cannot both start |
| digest or type differs | different command, payload, or target site | `COMMAND_ID_REUSED` -- fail closed |
| no stored digest | any | `COMMAND_DIGEST_UNVERIFIABLE` -- fail closed |

Under concurrent submission of two different commands sharing an id, exactly one
digest wins: the loser cannot overwrite it, cannot be answered from the winner's
result, and does not prevent the winner from being replayed.

The digest uses one canonicalization everywhere, with the preflight receipt
excluded -- receipts are binding metadata about a command, not part of it, so
attaching one cannot change which job the command matches.

**Enforced in both places.** The gate is not the boundary: the Worker applies
the same state machine in `evaluateClaim`, so a command arriving by any other
route is subject to it.

### The endpoint must be the installation the command names

`targetSite` matching local configuration is not enough. An environment copied
between installations -- endpoint and secrets belonging to site B while this
repository and the command name site A -- authenticates perfectly and would
mutate the wrong customer.

There is **one canonical identity**, `config/site-profile.json` -> `site.id`,
read by the gate directly and by the Worker through
`src/server/site-identity.ts`. No second, separately maintained copy.

- **The Worker** compares `context.targetSite` with its own identity *before*
  idempotency resolution and before any mutation, so the check holds for every
  route in and a replay cannot bypass it (`COMMAND_TARGET_SITE_MISMATCH`).
- **Authenticated control responses attest** the answering installation's
  `siteId`.
- **The gate** requires that attestation to agree with **both** the command's
  target and local configuration, on the first authenticated response -- so
  nothing reaches `/api/internal/commands` against the wrong site. A missing
  attestation is `REMOTE_SITE_IDENTITY_MISSING`; a disagreement is
  `REMOTE_SITE_IDENTITY_MISMATCH`. Both fail closed.

### What this does not open

A successful old-rule command replays; an **unknown** old-rule command is
refused under the current rule version like any other new work. The exemption
belongs to a specific completed command, matched by digest -- it is not a
stale-rule bypass, and not a preflight bypass. A lookup that cannot be read
fails closed: not knowing whether a command ran is not knowing it did not.


## Where a command may come from

Exactly one source: an inline envelope or a path to a committed one. The
workflow passes both of its inputs through verbatim so the gate sees an
ambiguous pair rather than silently preferring one and discarding the other —
which would dispatch an operation the operator did not intend. Both supplied is
`AMBIGUOUS_COMMAND`; neither is `NO_COMMAND`.

A `command_file` is read **from the committed Git blob, never from the working
tree**. "Tracked" is not "unmodified": a committed command file edited locally
would otherwise be dispatched, and -- since the gate echoes the command as the
operation record -- printed. Reading `HEAD:<path>` means the bytes dispatched
are exactly the bytes the repository carries.

After repository-relative path validation, the entry at `HEAD:<path>` must be a
regular committed blob:

- repository-relative, not absolute (`COMMAND_FILE_ABSOLUTE`)
- no `..` segment (`COMMAND_FILE_TRAVERSAL`)
- present in the HEAD tree (`COMMAND_FILE_NOT_TRACKED`)
- mode `100644`/`100755`, so not a directory (`COMMAND_FILE_NOT_A_FILE`), a
  symlink (`COMMAND_FILE_SYMLINK`) or a submodule

Resolving inside the HEAD tree removes a whole class of path attack: a blob
there cannot be an absolute path or a symlink target outside the repository,
because it is not a filesystem lookup at all. Git is invoked with an argv array
and `--`, never through a shell, and the check fails closed when git is
unavailable.

Nothing about the command is printed until it has parsed as JSON and passed the
schema. The operation record is written from the validated value, so neither an
unvalidated file nor a repository-external one can be published through the run
log.

## Running it

From the Actions tab, run **Dispatch site command** with either a JSON envelope
or a path to a committed one, and `dry_run` to run every gate without
dispatching. `dry_run` defaults to `true`.

Locally, against a disposable installation:

```bash
SITE_COMMAND_ENDPOINT=https://<worker-host> \
CONTROL_READ_HMAC_SECRET=... \
COMMAND_HMAC_SECRET=... \
node scripts/dispatch-command.mjs --command-file examples/commands/create-news.json --dry-run
```

Drop `--dry-run` to dispatch. Commands are idempotent by `commandId`: re-running
one that already succeeded returns the original result rather than repeating the
mutation.

## What the installation must provide

Configured on the `site-operations` environment of the repository.

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `SITE_COMMAND_ENDPOINT` | Origin of the deployed Worker, e.g. `https://site.example.workers.dev` |
| Secret | `COMMAND_HMAC_SECRET` | Signs the dispatch request. Must equal the Worker's secret of the same name |
| Secret | `CONTROL_READ_HMAC_SECRET` | Signs the preflight and readiness reads |

The Worker's `CONTROL_READ_SCOPES` must include `command:preflight` for gate 5,
`intake:read` for gate 4, and `command:read` for the replay lookup. The shipped
`wrangler.jsonc` grants all three.

Missing configuration is not a warning: the gate exits non-zero rather than
attempting an unauthenticated request.

## Putting a human in front of production

The workflow runs in the `site-operations` GitHub Environment. An installation
that wants human approval before site writes configures required reviewers on
that environment — the gate deliberately does not hardcode that policy, because
who may approve a change is an installation decision.

The workflow also uses a `concurrency` group so two commands cannot interleave;
commands carry `expectedVersion`, so overlapping runs would make the second fail
a version check it could otherwise have passed.

## Failure handling

Every failure names the gate and the code, and states plainly that nothing was
dispatched. `DAILY_OPERATION.md` applies: when a gate fails, refresh the current
state and prepare a new command. Do not bypass the gate with a direct database
or source edit — the Worker's scope boundary and the digest binding exist to
make that bypass detectable.

## What this gate does not do

It holds no mutation authority of its own. It signs a request; the Worker owns
authorization (`COMMAND_TRUSTED_SCOPES`), validation, versioning and the
mutation itself. Compromising the gate does not grant a scope the Worker has not
been configured to allow.
