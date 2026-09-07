# Getting Started

This repository is an agency/developer starter for building a website that a client can operate from ChatGPT.

The included Example Company site is intentionally simple. Treat it like a neutral corporate starter theme: verify the stack first, then replace the visual design and mock content with the client implementation.

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

`npm run verify` runs the production build and the contract checks. The contract
checks are what make a clean-environment install trustworthy: they validate the
shipped command examples against the current schemas, apply the migrations to a
brand-new database, confirm the committed Cloudflare identifiers are still
placeholders, and scan the tracked files for credential-shaped content. A green
build alone does not prove any of that.

The committed `package-lock.json` is the install contract. Do not regenerate dependencies as part of ordinary CI or deployment.

For local Cloudflare development, replace the placeholder resource identifiers in `wrangler.jsonc` with resources belonging to the installation. Do not commit real secrets.

## Configure the site

Start with:

- `config/site-profile.json`
- `config/page-capabilities.json`
- `wrangler.jsonc`

Replace placeholder values with installation-specific configuration. Keep secrets in the appropriate Cloudflare/GitHub secret stores rather than source control.

`docs/CONFIGURATION.md` is the complete reference for every binding, plaintext
variable, and secret the Worker reads, and for which ingress endpoints exist and
how each one authenticates.

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

See `EXTENDING_SITE_OPERATIONS.md` for the extension pattern and `DAILY_OPERATION.md` for the resulting client workflow.

## Before a real client handoff

Verify at least:

```text
clean clone
  -> npm ci
  -> npm run build
  -> provision disposable resources
  -> run migrations
  -> verify ordinary text/content operation
  -> verify image-bearing operation
  -> verify rendered public result
  -> verify failure paths do not bypass the command boundary
```

The client-facing goal is simple: once provisioning is complete, the client should be able to use ChatGPT for routine website updates without operating the infrastructure directly.
