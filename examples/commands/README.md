# Command examples

These files are reference inputs for implementers. They show how a natural-language request can be turned into a constrained command that the application validates and executes deterministically.

Use them as patterns, not as production data.

## Included examples

- `create-news.json` — a minimal text/content operation.
- `replace-content-image.json` — an image-bearing operation using the configured Asset Intake layer. Image-bearing commands set `context.requiresAssetIntake` to `true`; the authenticated readiness check belongs to the GitHub Actions dispatch gate, not to ChatGPT.

## Extension pattern

To make another part of a site operable from ChatGPT:

1. Define the state that may change.
2. Add or extend a validated command payload.
3. Route it through the existing command execution path.
4. Implement deterministic mutation logic in application code.
5. Render the state in Astro.
6. Add a focused test and one example command.

Do not expose unrestricted HTML, SQL, arbitrary JSON Patch, or raw application-state writes to ChatGPT.

See `docs/EXTENDING_SITE_OPERATIONS.md` for the full implementation pattern.
