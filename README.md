# ChatGPT Operated Site

> **Build websites your clients can update from ChatGPT.**

ChatGPT Operated Site is an open-source website operations starter for agencies, developers, freelancers, and teams building client websites.

The repository includes a simple English Astro corporate website together with the controlled operation layer underneath it. The included website is intentionally similar in spirit to a clean starter theme: it demonstrates the system without prescribing a client's brand or design.

**The client uses ChatGPT. The agency owns everything underneath.**

## Quick start

```bash
npm ci
npm run build
```

Then start with [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) for installation and handoff guidance.

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

## Documentation

- [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — installation and reference-site handoff
- [`docs/DAILY_OPERATION.md`](docs/DAILY_OPERATION.md) — intended client operation workflow
- [`docs/EXTENDING_SITE_OPERATIONS.md`](docs/EXTENDING_SITE_OPERATIONS.md) — adding new controlled site operations
- [`AGENTS.md`](AGENTS.md) — operating contract for coding/operation agents

## Project status

This repository is currently a **private OSS candidate** assembled from a reviewed clean extraction of the private production/development upstream. It is not ready for public release yet.

Before public release it will be validated through clean installation, build and contract checks, disposable provisioning, and an actual ChatGPT-operated end-to-end site workflow including image handling.
