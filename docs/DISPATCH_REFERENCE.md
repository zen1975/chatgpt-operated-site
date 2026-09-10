# GitHub Actions Dispatch Reference

This repository ships one small, replaceable reference adapter from a committed
Command JSON file to the Worker. It is the supported starter path, not the only
possible integration architecture.

## Golden path

1. Add a command JSON file that matches the current envelope and payload schema.
2. Commit the file. The workflow reads the blob at `HEAD`, not a working-tree copy.
3. Run **Dispatch Site Command** with its repository-relative path.
4. Keep `dry_run` enabled for the first run.
5. After the dry run succeeds, run it again with `dry_run` disabled.

The adapter performs a deliberately short sequence:

```text
committed command
  -> local schema, rule-version, and target-site checks
  -> configured provider readiness when a new provider reference is present
  -> authenticated Worker preflight and receipt binding
  -> authenticated Worker dispatch
```

The Worker remains authoritative for authentication, authorization, schema and
capability rules, optimistic versioning, idempotency, and mutation. Replacing
GitHub Actions must not remove those Worker checks.

## Two workflows

| Workflow | Trigger | Use |
| --- | --- | --- |
| `dispatch-command.yml` | manual (`workflow_dispatch`) | One named command, with an explicit dry-run switch. The path to read while learning the system. |
| `process-command.yml` | push to `main` under `commands/**` | Committing a command dispatches it. This is the path an operator can actually reach. |

`dispatch-command.yml` alone does not complete the Golden Path: ChatGPT can
commit a file, but it cannot open the Actions tab and press a button. Nothing
happens until a person does. `process-command.yml` closes that gap and holds
five properties that a bare `on: push` does not:

1. only newly added commands are dispatched
2. commands run one at a time, in path order
3. edits and deletions under `commands/**` are rejected -- it is an immutable log
4. every command is dry-run first; one failure stops the whole batch
5. a commandId that has been used before is rejected before dispatch

Property 5 matters more than it looks. A repeated commandId is treated by the
Worker as a replay: it returns success and applies nothing. The requester is
told the change was registered and the site does not change. That is the least
visible way this system can fail, so it is rejected twice -- by
`scripts/validate-commands.mjs`, which parses the JSON, and by a history scan
that catches ids reused across commits.

## The state directory

After dispatch, `process-command.yml` runs `scripts/refresh-state-index.mjs` and
commits the result to `state/`:

```text
state/content-index.json   current content ids, versions, URLs, body locations
state/page-index.json      current page ids, versions, section ids and versions
state/bodies/*.json        the stored body of each content item
```

Update commands require an `expectedVersion`, and the operator cannot sign a
control-plane read, so without this the only available numbers come from
`commands/**` -- a log of past operations, not current state. Every update then
fails on the version check.

`state/bodies/` exists for the same reason in the other direction: without the
stored body, an update has to be built from the rendered HTML, which silently
drops whatever rendering does not preserve. The content degrades a little on
every edit.

Read `state/`, never the published page, and never `commands/**`.

Regenerating `state/` on its own is the `workflow_dispatch` entry point of
`process-command.yml`. Re-running an old command does not refresh it: the
command has already been applied and fails on its version check.

## GitHub environment

Create a protected environment named `site-operations`.

| Name | Kind | Purpose |
| --- | --- | --- |
| `SITE_ENDPOINT` | Environment variable | Deployed site origin, such as `https://site.example.com`. |
| `CONTROL_READ_HMAC_SECRET` | Environment secret | Signs readiness and preflight requests. |
| `COMMAND_HMAC_SECRET` | Environment secret | Signs the final mutation request. |

Configure required reviewers on the environment when human approval is part of
the installation's operating policy. Never commit these values.

The workflow appears in the Actions UI only after its file exists on the default
branch. Before that, its tests run normally in the pull request.

## Image references

Readiness is required only when a command carries a new provider reference. A
canonical `assetId` already names an ingested asset and does not require Asset
Intake readiness.

The starter recognizes provider references on the three schemas that currently
accept them: `replace_asset`, `replace_product_asset`, and
`replace_page_section_asset`. Their provider must match
`config/site-profile.json`. When adding another reference-bearing command or
provider, extend the schema, adapter hook, documentation, and tests together.

`context.requiresAssetIntake` remains accepted for compatibility and as useful
operation metadata, but the dispatch adapter derives readiness from the
validated payload rather than trusting that flag.

## Boundaries

- The workflow accepts one committed JSON file; it does not accept inline JSON.
- Absolute paths, traversal, directories, symlinks, and uncommitted files are rejected.
- A preflight receipt is short-lived evidence, not permission to bypass Worker checks.
- The in-memory `create_asset` command is not a JSON transport. Use a bounded
  provider reference for new assets in this workflow.
- The included path is CI-tested. A disposable deployed-environment run and an
  actual ChatGPT-to-site acceptance run remain release acceptance steps.
- Other orchestrators may replace Actions if they preserve the same signed
  Worker contracts and fail closed on validation or preflight errors.

## Not included: implementer hardening

The adapter is deliberately small. A live installation with concurrent
operators, unreliable networks, or an untrusted operator population needs more
than this, and that work belongs to the implementer rather than to the
distribution:

- **Lease acquisition and stale-job takeover.** A crashed attempt leaves a job
  in `running`. Recovering it safely requires an owner token carried through the
  invocation and a fence that makes a superseded attempt's write fail, not
  merely match zero rows.
- **Transactional fencing of the domain mutation.** Optimistic version columns
  detect a conflict at the row; a fence makes the surrounding statement sequence
  fail so the whole batch rolls back.
- **Signed attestation.** Preflight receipts here are short-lived evidence
  passed between two trusted steps of one workflow. An installation that lets
  callers supply their own readiness evidence needs that evidence signed with a
  secret distinct from the command secret, and bound to the command digest,
  contract version, site, provider, and validity window.
- **Provider-side rate limiting and quota handling** beyond failing closed.
- **Operator authorization** finer-grained than the environment's reviewers.

Each is a legitimate production concern. None of them are required to
understand or reproduce the control path, which is what this repository is for.
See `AGENTS.md`, "Distribution scope".
