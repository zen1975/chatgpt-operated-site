# Agent Operating Contract

This repository has two different operating modes. Do not mix them in one task.

## 1. Daily operation

Daily operation means changing a configured client website through the supported command system.

Before writing anything:

1. Confirm the target repository and target site.
2. Read `config/site-profile.json`.
3. Read `docs/DAILY_OPERATION.md`.
4. Use the current command schema as structural authority.
5. Use only capabilities explicitly exposed by the application.

For operations that introduce a new provider-backed asset, keep `context.requiresAssetIntake: true` as operation metadata. The reference dispatch adapter derives readiness from the validated provider reference; canonical `assetId` operations do not require Asset Intake. An alternative orchestrator may replace GitHub Actions, but it must preserve the signed Worker contracts and fail closed.

Do not invent alternate mutation paths. Do not write arbitrary SQL, HTML, CSS, JavaScript, or JSON patches as a substitute for a supported command.

If validation, readiness, version checks, dispatch, or mutation fails, stop rather than attempting an unreviewed bypass.

## 2. Development

Development means changing the starter, schemas, handlers, rendering, tests, provisioning, or capabilities.

When adding a new operable site area, follow `docs/EXTENDING_SITE_OPERATIONS.md`:

```text
state
  -> capability
  -> command schema
  -> deterministic handler
  -> rendering / projection
  -> tests
  -> ChatGPT operation example
  -> end-to-end verification
```

The LLM interprets intent and prepares an allowed operation. Application code owns the actual rules, validation, mutation, versioning, and reproducibility.

## Structural authority

When examples and implementation differ, use this order:

```text
current schema
  > current operation documentation
  > current tested example
  > conversational description
```

Examples demonstrate a route; they do not override the current schema.

## Distribution scope

This repository is read before it is run. An implementer's cost is the amount of
code they must understand before they can rebuild the structure themselves, so
the limiting rule is what this distribution refuses to carry, not what it could
usefully contain.

Out of scope here, and named as implementer hardening in
`docs/DISPATCH_REFERENCE.md`:

- lease acquisition, stale-job takeover, and transactional fencing
- replay machinery beyond the idempotency the command contract already states
- signed attestation layered on top of the command signature
- command classification or capability-derivation layers
- mutation testing, and test suites that grow faster than the code they cover

None of these are wrong. They are the work a live installation needs and a
baseline does not, and a distribution that carries them stops being readable as
a starting point.

Two rules follow.

**Judge a review finding by scope before correctness.** A finding can be
entirely correct and still belong outside this distribution. Record a
correct-but-out-of-scope finding as implementer hardening; do not implement it
here. Accepting every correct finding is precisely how a baseline stops being
one, because no single step ever looks like the wrong decision.

**Keep one path.** Where the repository already shows a way to do something, do
not add a second. A new mechanism replaces the old one or is not added.

## Repository safety

Never infer repository identity from a similar name, previous conversation, or recent repository. Confirm the active repository before a write.

Do not place production commands, production identifiers, customer credentials, private acceptance evidence, or private-upstream history in this public distribution.
