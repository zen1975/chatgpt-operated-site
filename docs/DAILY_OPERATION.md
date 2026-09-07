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

```text
Client request
  -> ChatGPT interprets intent
  -> supported Command is prepared
  -> GitHub receives an immutable command record
  -> GitHub Actions validates and dispatches it
  -> Cloudflare Worker performs the controlled mutation
  -> D1 / R2 become the updated source of truth
  -> Astro renders the resulting site state
```

The exact command payload must match the current schema in `src/server/command-schema.ts` and the relevant capability policy.

## Images

For an operation that needs a new image, the client can attach the image in the ChatGPT interaction supported by the configured installation.

The operation command should mark:

```json
{
  "context": {
    "requiresAssetIntake": true
  }
}
```

The configured Asset Intake layer is installer infrastructure, not a second client interface. The authenticated readiness check belongs to the GitHub Actions dispatch gate.

## Version and validation failures

Commands that modify existing versioned state use expected-version checks. If the current state no longer matches the expected version, refresh the current state and prepare a new command rather than forcing the old mutation.

If schema validation, capability validation, Asset Intake readiness, dispatch, or mutation fails, stop. Do not bypass the supported path with direct database or arbitrary source edits.

## The starter is not the operation limit

The included Example Company site only demonstrates the pattern. A developer can make additional site areas operable by explicitly defining their state, capability, command schema, deterministic implementation, rendering, and tests. See `EXTENDING_SITE_OPERATIONS.md`.
