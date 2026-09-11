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

That proves the baseline on an unmodified clone. To get from there to a live site that publishes an article when you push a file, follow [`docs/QUICK_START.md`](docs/QUICK_START.md) — around thirty minutes, mostly waiting on Cloudflare.

After that: [`docs/IMPLEMENTER_CHECKLIST.md`](docs/IMPLEMENTER_CHECKLIST.md) is the shortest path from this repository to a real client implementation, [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) has the fuller installation and handoff guidance, and [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) documents the GitHub Actions dispatch path.

## The operator instructions ship with it

The client talks to ChatGPT. What tells ChatGPT how to behave is [`ai/`](ai/), and it is part of the baseline rather than something each implementer invents.

Correct code with absent or badly placed instructions does not produce a working installation. [`ai/README.md`](ai/README.md) explains the one rule that matters most: whether a rule goes in the pasted setup text or in the repository depends on **when it has to take effect**, not on what it says.

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

### What that actually does

The sentence on the left is the whole client-facing interface. Everything below it is a file in a repository, reviewable and revertable like any other change.

```text
  "Publish this as a news post."
       |
       v
  commands/2026/09/autumn-hours.json      an immutable command file
       |                                   { "command": "create_news",
       |                                     "payload": { "title": ..., "blocks": [...] } }
       v
  git push
       |
       v
  validate -> reject duplicates -> dry-run -> dispatch -> render
                                              (the dispatch request
                                               is HMAC-signed)
       |
       v
  https://example.com/news/autumn-hours/   and state/ now records its version
```

The command file itself is immutable once committed; the signature is on the dispatch request that carries it to the Worker, not on the file.

There is no admin dashboard. This is the one canonical operating path for client changes, which is why the site's operating history is the repository's history. Other API ingress exists for implementers and for emergency use, and each is documented in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

### Done means three things

```text
1. The dispatch succeeded
2. The rendered site shows the requested state
3. What the operator told the requester matches 1 and 2
```

The third is not decoration. The operator is the only surface the client sees, so a correct system that reports incorrectly has not delivered anything. This system has produced both failures: a success reported as a failure, and a success reported with a URL that returned 404.

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
- [`docs/QUICK_START.md`](docs/QUICK_START.md) — clean clone to a live site that publishes on push
- [`docs/FORK_AND_UPSTREAM.md`](docs/FORK_AND_UPSTREAM.md) — what a fork may override, and what belongs back here
- [`ai/README.md`](ai/README.md) — operator instruction templates and where each rule belongs
- [`docs/ASSET_INTAKE_SETUP.md`](docs/ASSET_INTAKE_SETUP.md) — provisioning the Google Drive intake folder and its credential
- [`docs/DAILY_OPERATION.md`](docs/DAILY_OPERATION.md) — intended client operation workflow
- [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) — minimal, replaceable GitHub Actions dispatch adapter
- [`docs/EXTENDING_SITE_OPERATIONS.md`](docs/EXTENDING_SITE_OPERATIONS.md) — adding new controlled site operations
- [`AGENTS.md`](AGENTS.md) — operating contract for coding/operation agents
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup and what the contract checks enforce
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and the security design expectations

## Project status

The baseline has been run, not just assembled.

- A real company website was built on it and operated for four days through ChatGPT by someone who does not read code, on both desktop and a phone, for text and for images.
- Doing that surfaced 35 defects, gaps, and missing documents. All of them are recorded; the ones that blocked a clean-clone reproduction are fixed.
- The golden path has since been reproduced twice more on throwaway Cloudflare installations built from clean clones: provision, migrate, deploy, publish an article, render it, and write the current state back. The image half — one command publishing an article together with its picture — was proven on the first of the two.

Clean installation, build, contract checks, schema/example checks, migration checks, placeholder checks, and tracked-file secret scans run in CI.

What that does **not** mean: that every downstream Cloudflare, Google, or GitHub account is already provisioned. Each real installation still completes its own provisioning and end-to-end acceptance before client handoff. See [`docs/QUICK_START.md`](docs/QUICK_START.md) for what that takes.

The repository remains private until the owner chooses to publish it.

The dispatch adapter in [`docs/DISPATCH_REFERENCE.md`](docs/DISPATCH_REFERENCE.md) is a reference implementation of the golden path, not production acceptance evidence. Hardening it for a live installation is the implementer's work.

## Licence

[MIT](LICENSE).
