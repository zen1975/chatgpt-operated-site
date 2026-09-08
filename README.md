# ChatGPT Operated Site

> **Build websites your clients can update from ChatGPT.**

ChatGPT Operated Site is an open-source website operations starter for agencies, developers, freelancers, and teams building client websites.

The repository includes a simple English Astro corporate website together with the controlled operation layer underneath it. The included website is intentionally similar in spirit to a clean starter theme: it demonstrates the system without prescribing a client's brand or design.

**The client uses ChatGPT. The agency owns everything underneath.**

## Quick start

```bash
npm ci
npm run verify   # build + contract checks
```

Then use [`docs/IMPLEMENTER_CHECKLIST.md`](docs/IMPLEMENTER_CHECKLIST.md) as the shortest path from this repository to a real client implementation. [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) contains the fuller installation and handoff guidance, and [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) documents the minimal GitHub Actions golden path.

## What is included

- A simple English Astro target site with neutral mock text and mock assets
- Cloudflare Workers, D1, and R2 integration
- Controlled Command schemas and deterministic handlers
- GitHub-based operation and dispatch flow
- Content, image, page-composition, SEO, and projection foundations
- Documentation for extending the operation model

## The included Astro site is a reference implementation

The starter site is not the product boundary. It is an example of a real website that can be operated through ChatGPT.

A developer can replace its design with a client's site while keeping the operation infrastructure underneath. The public starter uses neutral English content and mock assets so that it can be understood, modified, and redistributed without depending on a production brand or customer website.

## Operate any part of your site

ChatGPT Operated Site is **not limited to news posts, articles, or the components included in the starter**.

Developers can expose virtually any appropriate part of their website as a controlled operation, including:

- homepage headlines, copy, images, and calls to action
- navigation and footer content
- company information, addresses, phone numbers, and opening hours
- services, cards, sections, statistics, timelines, and FAQs
- news and article creation, editing, publishing, and images
- page metadata, SEO descriptions, OGP data, and structured data
- custom Astro components and application-specific content

The developer decides what can change and how it changes. ChatGPT provides the natural-language interface; the application remains in control of the operation.

```text
Developer
  -> defines a capability
  -> defines its schema / command
  -> implements deterministic behavior
  -> tests the operation
  -> exposes it to ChatGPT
```

This is intentionally different from giving an AI unrestricted access to HTML, SQL, or application state.

See [`docs/EXTENDING_SITE_OPERATIONS.md`](docs/EXTENDING_SITE_OPERATIONS.md) for the reference extension pattern.

## Client experience

A configured client should be able to make ordinary requests such as:

```text
"Change the homepage headline."
"Replace the hero image with this image."
"Add Consulting to our Services section."
"Change our Sunday opening hours to 6 PM."
"Add this question to the FAQ."
"Publish this as a news post."
"Update the SEO description for the About page."
```

The client should not need to understand the implementation details behind those operations. See [`docs/DAILY_OPERATION.md`](docs/DAILY_OPERATION.md) for the operating model.

## Architecture

```text
Client
  -> ChatGPT
  -> immutable Command
  -> GitHub Actions validation / dispatch
  -> Cloudflare Worker controlled mutation
  -> D1 / R2 source of truth
  -> Astro website / projections
```

**ChatGPT is the interface. Everything else is infrastructure.**

## What this repository promises

This repository is a **reference implementation and construction baseline** for implementers. It is intended to give an agency or developer enough working code, schemas, examples, configuration, and documentation to build their own client installation from it.

The baseline is considered useful when a clean clone can install, `npm run verify` is green, the included examples match the current schemas, and the extension points are understandable from the repository itself.

It is **not** intended to be a hosted service, a finished client website, or a promise that every downstream Cloudflare/Google/GitHub account is already provisioned. Real client provisioning and end-to-end acceptance belong to the implementer's installation and handoff process.

It is also not a hardened control plane. Lease recovery, transactional fencing, signed attestation, and similar production concerns are named in [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) as the implementer's work and deliberately left out, because a baseline that carries them is no longer readable as one. [`AGENTS.md`](AGENTS.md) states the scope rule that keeps it that way.

## Documentation

- [`docs/IMPLEMENTER_CHECKLIST.md`](docs/IMPLEMENTER_CHECKLIST.md) — shortest path from fork to client implementation
- [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — installation and reference-site handoff
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — every binding, variable, and secret the Worker reads
- [`docs/GOOGLE_DRIVE_ASSET_INTAKE.md`](docs/GOOGLE_DRIVE_ASSET_INTAKE.md) — new-installation setup for the optional Google Drive intake provider
- [`docs/DAILY_OPERATION.md`](docs/DAILY_OPERATION.md) — intended client operation workflow
- [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) — minimal, replaceable GitHub Actions dispatch adapter
- [`docs/EXTENDING_SITE_OPERATIONS.md`](docs/EXTENDING_SITE_OPERATIONS.md) — adding new controlled site operations
- [`AGENTS.md`](AGENTS.md) — operating contract for coding/operation agents
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup and what the contract checks enforce
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and the security design expectations

## Project status

The **implementer baseline is assembled and continuously verified**. Clean installation, build, contract checks, schema/example checks, migration checks, placeholder checks, and tracked-file secret scans run in CI.

The repository remains private until the owner chooses to publish it. Making it public does not require proving every possible client deployment first; each real installation should still complete its own provisioning and end-to-end acceptance before client handoff.

The dispatch adapter in [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) is a reference implementation of the golden path, not production acceptance evidence. Hardening it for a live installation is the implementer's work.

## Licence

[MIT](LICENSE).
