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
npm install
npm run build
```

This starter intentionally keeps the install path simple for implementers. `package.json` pins the supported direct dependency versions. If your implementation needs a committed lockfile, generate and commit one in your own project after you choose the versions you want to maintain.

For local Cloudflare development, replace the placeholder resource identifiers in `wrangler.jsonc` with resources belonging to the installation. Do not commit real secrets.

## Configure the site

Start with:

- `config/site-profile.json`
- `config/page-capabilities.json`
- `wrangler.jsonc`

Replace placeholder values with installation-specific configuration. Keep secrets in the appropriate Cloudflare/GitHub secret stores rather than source control.

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
  -> npm install
  -> npm run build
  -> provision resources
  -> run migrations
  -> verify one ordinary text/content operation
  -> verify one image-bearing operation if you use Asset Intake
  -> verify the rendered public result
```

The client-facing goal is simple: once provisioning is complete, the client should be able to use ChatGPT for routine website updates without operating the infrastructure directly.
