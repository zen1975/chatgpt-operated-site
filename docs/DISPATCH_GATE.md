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
| 3 | Preflight | authenticated read | Missing target, or `expectedVersion` no longer matching current state |
| 4 | Asset Intake readiness | authenticated read | An image-bearing command when the provider is not usable |

Gates 1 and 2 are purely local: they need no credentials and no network, so a
malformed command never reaches the installation at all.

Gate 4 runs only when the command sets `context.requiresAssetIntake: true`.

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

The Worker's `CONTROL_READ_SCOPES` must include `command:preflight` for gate 3
and `intake:read` for gate 4. The shipped `wrangler.jsonc` grants both.

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
