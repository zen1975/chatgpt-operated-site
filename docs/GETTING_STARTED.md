# Getting Started

This repository is an agency/developer starter for building a website that a client can operate from ChatGPT.

The included Example Company site is intentionally simple. Treat it like a neutral corporate starter theme: verify the stack first, then replace the visual design and mock content with the client implementation.

Use `IMPLEMENTER_CHECKLIST.md` as the shortest path from a clean fork to client handoff. The included GitHub Actions operation path is documented in `DISPATCH_REFERENCE.md`.

## Requirements

- Node.js 22.23.2
- npm 10.9.8
- a Cloudflare account for deployment
- client/agency-owned GitHub infrastructure
- D1 and R2 resources matching the bindings in `wrangler.jsonc`
- optional configured Asset Intake provider for image-bearing operations

## Install and verify locally

```bash
npm ci
npm run verify
```

`npm run verify` runs the production build and the contract checks. The contract checks validate the shipped command examples against the current schemas, apply the migrations to a brand-new database, confirm the committed Cloudflare identifiers are still placeholders, and scan the tracked files for credential-shaped content.

The committed `package-lock.json` is the install contract. Do not regenerate dependencies as part of ordinary CI or deployment.

If these two commands are green on a clean clone, the repository baseline itself is working. You can then begin adapting it to a real client.

For local Cloudflare development, replace the placeholder resource identifiers in `wrangler.jsonc` with resources belonging to the installation. Do not commit real secrets.

## Configure the site

Start with:

- `config/site-profile.json`
- `config/page-capabilities.json`
- `wrangler.jsonc`

Replace placeholder values with installation-specific configuration. Keep secrets in the appropriate Cloudflare/GitHub secret stores rather than source control.

`docs/CONFIGURATION.md` is the complete reference for every binding, plaintext variable, and secret the Worker reads, and for which ingress endpoints exist and how each one authenticates. If the installation enables Google Drive Asset Intake, complete `docs/GOOGLE_DRIVE_ASSET_INTAKE.md` before testing image-bearing operations.

## Replace the reference website

The public starter includes an English Example Company site with mock text and an owned neutral SVG illustration. It is a target-site reference implementation, not a required design.

You can replace:

- layout and visual design
- header and navigation
- homepage sections
- About / Services / Contact pages
- mock text and mock images
- page and component structures

while retaining the controlled operation infrastructure.

## Make client-specific areas operable

Do not make arbitrary DOM or database state writable. Define each operation intentionally.

See `EXTENDING_SITE_OPERATIONS.md` for the extension pattern and `DAILY_OPERATION.md` for the resulting client workflow. Use `DISPATCH_REFERENCE.md` when installing the included GitHub Actions adapter.

## Baseline complete vs client handoff complete

These are deliberately separate.

The **repository baseline is complete** when a clean clone installs and `npm run verify` is green. That is the point at which an implementer has a trustworthy base to build from.

A **real client installation** still needs its own account provisioning and acceptance. Before handing a client that installation, verify at least:

```text
configure client-owned GitHub / Cloudflare / optional Asset Intake
  -> provision D1 / R2 and other required bindings
  -> run migrations
  -> configure one ChatGPT-facing operation path
  -> verify one ordinary text/content operation
  -> verify one image-bearing operation if images are enabled
  -> verify the rendered public result
```

Those deployment-specific checks should not be confused with the job of this repository: providing a working, understandable construction baseline.

The client-facing goal is simple: once provisioning is complete, the client should be able to use ChatGPT for routine website updates without operating the infrastructure directly.
