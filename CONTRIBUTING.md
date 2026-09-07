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
rather not match those on your host, `docker build -t chatgpt-operated-site .`
reproduces the supported environment.

Do not regenerate `package-lock.json` as part of an unrelated change, and do not
bump dependencies opportunistically. Dependency changes are their own pull
request with their own rationale.

## What `npm run verify` checks

`npm run build` runs `astro check` and the production build. `npm run
test:contract` runs the contract suite in `tests/`, which asserts:

- every example in `examples/commands/` validates against the **current** Zod
  schemas in `src/server/`, including the runtime rule version — an example that
  cannot actually execute is a failing test
- the published JSON Schemas in `schemas/` have not drifted from the
  implementation
- the migrations in `migrations/` are sequential, append-only, and apply in
  order to a brand-new database
- no tracked file contains credential-shaped content, private-upstream
  identifiers, or non-English content
- the committed Cloudflare identifiers are still placeholders
- every `wrangler.jsonc` binding is typed in `src/env.d.ts`, every secret the
  Worker reads is documented in `docs/CONFIGURATION.md`, and every Makefile and
  Dockerfile reference points at something the repository actually ships

If you change a schema, the failing contract test is telling you which
downstream artifact to update — update it rather than relaxing the test.

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
  test:contract` a clean clone would.
- Never include production identifiers, customer content, credentials, or
  private acceptance evidence.
