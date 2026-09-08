# Daily Operation

This document describes the intended client-facing operation model after an agency or developer has provisioned the site.

## Client experience

The client uses ChatGPT as the interface. Ordinary requests can look like:

```text
Change the homepage headline.
Replace the hero image with this image.
Publish this as a news post.
Update our opening hours.
Add this question to the FAQ.
Update the SEO description for the About page.
```

The client should not need to open GitHub, Cloudflare, D1, R2, or the Asset Intake storage layer for routine updates.

## What happens underneath

The included reference path is:

```text
Client request
  -> ChatGPT interprets intent
  -> the installation's ChatGPT-facing integration prepares a supported Command
  -> GitHub receives an immutable command record
  -> GitHub Actions validates and dispatches it
  -> Cloudflare Worker performs the controlled mutation
  -> D1 / R2 become the updated source of truth
  -> Astro renders the resulting site state
```

The exact command payload must match the current schema in `src/server/command-schema.ts` and the relevant capability policy. See `DISPATCH_REFERENCE.md` for the included GitHub Actions path.

## Installation boundary

This repository implements the controlled Worker endpoints and a reference GitHub Actions adapter. It does not automatically connect a ChatGPT account to an installation.

Before client handoff, the installer must configure a ChatGPT-facing integration that can prepare the validated Command and hand it to the selected adapter using operator-owned credentials. For the included path, that integration creates a new immutable command record in GitHub and invokes **Dispatch Site Command**. An authenticated command client may instead replace the Actions adapter and use `/api/v1/commands`, as listed in `CONFIGURATION.md`.

Choose one canonical daily-operation path per installation. Do not run GitHub Actions and direct REST as competing mutation paths. Any replacement must preserve the signed Worker contracts, schema and capability validation, expected-version checks, and fail-closed behavior.

## Images

For an operation that needs a new image, the client can attach the image in the ChatGPT interaction supported by the configured installation.

A command that introduces a new provider-backed asset may keep
`context.requiresAssetIntake: true` as operation metadata. The reference
dispatch adapter derives the actual readiness requirement from the validated
provider reference rather than trusting that flag. A command that uses an
existing canonical `assetId` does not need Asset Intake readiness.

The configured Asset Intake layer is installer infrastructure, not a second
client interface. GitHub Actions is the included reference adapter; another
orchestrator may replace it if the signed Worker contracts and fail-closed
validation are preserved.

## Version and validation failures

Commands that modify existing versioned state use expected-version checks. If the current state no longer matches the expected version, refresh the current state and prepare a new command rather than forcing the old mutation.

If schema validation, capability validation, Asset Intake readiness, dispatch, or mutation fails, stop. Do not bypass the supported path with direct database or arbitrary source edits.

## The starter is not the operation limit

The included Example Company site only demonstrates the pattern. A developer can make additional site areas operable by explicitly defining their state, capability, command schema, deterministic implementation, rendering, and tests. See `EXTENDING_SITE_OPERATIONS.md`.
