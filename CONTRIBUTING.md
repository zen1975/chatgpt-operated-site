# Contributing

Thanks for helping improve this starter.

## Before you start

Read [`AGENTS.md`](AGENTS.md). It defines the two operating modes of this
repository and the structural authority order used when documentation,
examples, and implementation disagree:

```text
current schema > current operation documentation > current tested example > conversational description
```

Changes to this repository are **development**, not daily site operation.

## Local setup

```bash
npm ci        # the committed package-lock.json is the install contract
npm run verify   # build + contract checks
```

Requires Node 22.23.2 and npm 10.9.8, as pinned in `package.json`. If you would
rather not match those on your host, the container reproduces the supported
environment and runs the same verification:

```bash
docker build -t sitewright .
docker run --rm sitewright
```

The image carries no git metadata, so this also exercises the contract checks
against the distribution as shipped rather than against a checkout. Both are
run in CI.

Do not regenerate `package-lock.json` as part of an unrelated change, and do not
bump dependencies opportunistically. Dependency changes are their own pull
request with their own rationale.

## What `npm run verify` checks

`npm run build` runs `astro check` and the production build. `npm run
test:contract` runs the contract suite in `tests/`, which asserts:

- every example in `examples/commands/` validates against the **current** Zod
  schemas in `src/server/`, including the runtime rule version — an example that
  cannot actually execute is a failing test
- the published JSON Schemas in `schemas/` are byte-identical to what
  `npm run schemas:generate` produces from the Zod source, so every constraint
  Zod can express — required, type, enum, format, pattern, limits, uniqueItems,
  defaults, `additionalProperties` — is compared, not just property names
- the migrations in `migrations/` are sequential, append-only, and apply in
  order to a brand-new database, and their committed digests still match (see
  **Migrations are immutable** below)
- no tracked file contains credential-shaped content, private-upstream
  identifiers, or non-English content, and each shipped example still carries
  placeholders in its declared installation-specific fields
- the committed Cloudflare identifiers are still placeholders
- every environment name `src/` actually reads — extracted from the code, not
  listed by hand — is typed in `src/env.d.ts` and documented in
  `docs/CONFIGURATION.md`, and every Makefile and Dockerfile reference points at
  something the repository actually ships

If you change a schema, run `npm run schemas:generate` and commit the result.
The failing contract test is telling you which downstream artifact to update —
update it rather than relaxing the test.

## Migrations are immutable

An already-applied migration must never be edited — not even with entirely
non-destructive SQL. Existing installations have run it and will never run it
again, so they diverge permanently from a database built fresh. To change the
schema, add a new sequential migration.

This is enforced in **two complementary layers**, because neither is sufficient
alone.

### 1. Checksum manifest integrity — inside a distribution

`migrations/CHECKSUMS.json` pins the content of every migration, and
`npm run test:contract` fails when the manifest and the files disagree.

This layer needs no git, which is why it also runs inside the Docker image,
where there is neither git metadata nor a git binary. It answers: *is this copy
of the distribution internally consistent?*

What it **cannot** do is enforce immutability by itself. A contributor can edit
an applied migration, run `npm run migrations:checksums`, and commit both
changes — the manifest is then consistent again and this layer passes. The
manifest records the edit; it does not prevent it.

When you add a migration, run:

```bash
npm run migrations:checksums
```

### 2. Base-relative immutability — in pull-request CI

Only the base revision knows what was already released, so pull requests are
additionally checked against it:

```bash
npm run test:migrations:base -- --base <sha-or-ref>
```

Every `.sql` migration present in the base must still exist byte-for-byte. New
migrations may be added; modifying, deleting, or renaming an existing one fails.
CI runs this with the pull request's own base SHA — never a hardcoded branch —
and `actions/checkout` uses `fetch-depth: 0` so the base revision is present.

The check **fails closed**: if the base revision cannot be inspected — no base
given, unresolvable ref, or a shallow clone missing the object — it exits
non-zero rather than skipping. A check that passes silently when it cannot look
is worse than no check.

It is deliberately **not** part of `npm run verify`, so the container
verification stays independent of git.

## Adding a new operable site area

Follow [`docs/EXTENDING_SITE_OPERATIONS.md`](docs/EXTENDING_SITE_OPERATIONS.md)
in order:

```text
state -> capability -> command schema -> deterministic handler
      -> rendering / projection -> tests -> ChatGPT operation example
      -> end-to-end verification
```

A capability without a test and an example is not finished.

## Security-affecting changes

Read the design expectations in [`SECURITY.md`](SECURITY.md) before touching an
ingress endpoint, an authorization scope, or credential handling. Report
vulnerabilities privately rather than in a pull request.

## Pull requests

- Keep a pull request to one reviewable change.
- Include implementation, tests, and the documentation the change invalidates in
  the same pull request.
- CI must pass. It runs the same `npm ci` / `npm run build` / `npm run
  test:contract` a clean clone would, plus the base-relative migration
  immutability check and the container verification.
- Never include production identifiers, customer content, credentials, or
  private acceptance evidence.
