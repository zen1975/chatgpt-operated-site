# Implementer Checklist

This repository is a construction baseline, not a finished hosted product. The goal is simple: an agency or developer should be able to fork it, replace the reference website, provision their own infrastructure, and expose the site operations their client needs.

## 1. Prove the baseline first

```bash
npm ci
npm run verify
```

Do not redesign the site or add client-specific commands until the baseline passes.

## 2. Replace installation placeholders

Review and replace the example values in:

- `config/site-profile.json`
- `config/page-capabilities.json`
- `wrangler.jsonc`

Provision the Cloudflare resources referenced by the installation and keep secrets out of the repository. See `docs/CONFIGURATION.md`. When Google Drive is the selected Asset Intake provider, complete `docs/GOOGLE_DRIVE_ASSET_INTAKE.md` with credentials and a folder owned by that installation.

## 3. Replace the reference website

Treat the included Example Company site like a starter theme. Replace the branding, pages, layout, components, copy, and images with the real client site.

The included design is not a framework restriction. It is only a readable reference implementation.

Treat legacy-site migration, site-specific editorial or approval policies, and route-specific visual acceptance as client construction work. Add only what that installation needs; do not copy production/demo identifiers, credentials, routes, or acceptance evidence into the baseline.

## 4. Decide what the client may operate

List the actual client requests you want to support, for example:

```text
Change the homepage headline.
Replace the hero image.
Update opening hours.
Add a service.
Publish a news post.
Update an FAQ.
Change the About-page SEO description.
```

For each request, define an explicit capability rather than giving ChatGPT arbitrary access to HTML, SQL, or application state.

## 5. Implement each capability through the existing pattern

```text
ChatGPT request
  -> validated Command
  -> deterministic handler
  -> D1 / R2 state
  -> Astro renderer / projection
```

Use `docs/EXTENDING_SITE_OPERATIONS.md` and the files under `examples/commands/` as references.

## 6. Keep one controlled mutation path

New functionality should extend the current command/handler model. Do not add a second ad-hoc write path just because a client-specific feature is different.

ChatGPT is the operator. Application code owns the rules and reproducibility.

## 7. Connect ChatGPT to the controlled dispatch

Use `docs/DISPATCH_REFERENCE.md` as the minimal included GitHub-to-Worker reference. The workflow starts from a committed Command file; it does not automatically configure ChatGPT, create that record, or invoke the workflow.

Before handoff, configure one ChatGPT-facing integration that prepares a schema-valid Command and sends it through the installation's selected adapter using operator-owned credentials. If the installation keeps the included Actions path, the integration must create a new immutable command record and invoke **Dispatch Site Command**. If it replaces Actions with an authenticated client using `/api/v1/commands`, preserve the same signed Worker contracts and fail-closed checks.

Choose one canonical daily-operation path for the installation rather than operating both paths in parallel.

## 8. Verify the real installation

Before client handoff, verify at least one ordinary text/content operation and one image-bearing operation against the actual provisioned installation.

The repository does not need to pre-prove every downstream client environment. Each implementer proves the installation they deliver.

## Definition of done for an implementer

The implementation is ready for handoff when:

- the repository installs and verifies cleanly
- client-owned Cloudflare/GitHub/asset infrastructure is configured
- the reference design has been replaced as needed
- required site areas have explicit capabilities
- one canonical ChatGPT-facing operation path is configured
- representative commands work end to end
- the client can make routine updates from ChatGPT without operating the infrastructure directly

Anything beyond that is project-specific hardening, not a requirement for using this repository as a base.
