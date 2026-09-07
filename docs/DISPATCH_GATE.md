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

## The four gates

They run in a fixed order and every one fails closed. Nothing is dispatched
unless all of them pass.

| # | Gate | Network | What stops here |
| --- | --- | --- | --- |
| 1 | Schema | none | Envelope or payload that does not match the current Zod contracts in `src/server` |
| 2 | Rule version | none | `context.ruleVersion` differing from this installation's rule version |
| 3 | Target site | none | A command written for a different installation |
| 4 | Asset Intake readiness | authenticated read | A command carrying an intake source whose provider is not usable |
| 5 | Preflight | authenticated read | Missing target, or `expectedVersion` no longer matching current state |

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

### Gate 4: derived from the payload, not declared by the caller

`context.requiresAssetIntake` is optional caller-supplied metadata, so it is not
what decides whether readiness runs. The requirement is read out of the
validated payload:

| Command | Intake source | Provider from |
| --- | --- | --- |
| `create_asset` | always | `payload.descriptor.sourceProvider` |
| `import_wordpress_asset` | always | the command itself (`wordpress`) |
| `replace_asset`, `attach_product_asset`, `replace_product_asset`, `replace_page_section_asset` | only when `payload.reference` is present | `payload.reference.provider` |

A reference-bearing command may instead carry a canonical `assetId` that is
already inside the Asset Engine; that needs no intake.

The flag is then cross-checked against the derived answer, and a contradiction
in **either** direction is rejected (`ASSET_INTAKE_FLAG_MISSING`,
`ASSET_INTAKE_FLAG_UNEXPECTED`) rather than resolved silently.

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

## Recovering a lost dispatch response

Commands are immutable and idempotent by `commandId`, but a dispatch can commit
its mutation and still lose the response — a dropped connection, a cancelled
run. Re-running the same command then meets a difficulty: the mutation already
happened, so its `expectedVersion` is now legitimately stale, and preflight
would report a conflict for a command that in fact succeeded.

Before the state gates, the gate therefore asks the installation whether this
exact `commandId` already completed, via `GET /api/control/commands/{commandId}`
(scope `command:read`):

- **Recorded as successful** → the state gates are skipped and the command is
  re-sent. The Worker resolves idempotency by `commandId` before any contract
  gate and returns the original result. No second mutation. If the Worker
  answers non-idempotently, the gate stops (`REPLAY_NOT_IDEMPOTENT`) rather than
  risk one.
- **Recorded as failed, or not known** → ordinary work. Every gate runs.
- **Lookup itself fails** → fail closed. Not knowing whether a command ran is
  not the same as knowing it did not.

This is not a general preflight bypass: only a `commandId` the installation has
already recorded as successful takes this path.

## Where a command may come from

Exactly one source: an inline envelope or a path to a committed one. The
workflow passes both of its inputs through verbatim so the gate sees an
ambiguous pair rather than silently preferring one and discarding the other —
which would dispatch an operation the operator did not intend. Both supplied is
`AMBIGUOUS_COMMAND`; neither is `NO_COMMAND`.

A `command_file` path is part of the trust boundary, because the gate echoes the
command as the operation record. Before the file is opened it must:

- be repository-relative (`COMMAND_FILE_ABSOLUTE`)
- contain no `..` segment (`COMMAND_FILE_TRAVERSAL`)
- resolve — via its **real** path, so a symlink cannot escape by looking
  innocent — inside the repository (`COMMAND_FILE_OUTSIDE_REPOSITORY`)
- be a regular file (`COMMAND_FILE_NOT_A_FILE`)
- be committed (`COMMAND_FILE_NOT_TRACKED`)

The tracking check fails closed when git is unavailable: a dispatched command
must be one the repository actually carries, and "cannot tell" is not "yes".

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
