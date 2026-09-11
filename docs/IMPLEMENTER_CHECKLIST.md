# Implementer Checklist

This repository is a construction baseline, not a finished hosted product. The goal is simple: an agency or developer should be able to fork it, replace the reference website, provision their own infrastructure, and expose the site operations their client needs.

## 1. Prove the baseline first

```bash
npm ci
npm run verify
```

Do not redesign the site or add client-specific commands until the baseline passes.

Then build one throwaway installation and publish one article through it, following `docs/QUICK_START.md`. Reading the architecture is not the same as having watched a command reach a rendered page, and the throwaway installation is where you find out which step your environment argues with.

## 2. Replace installation placeholders

Review and replace the example values in:

- `config/site-profile.json`
- `config/page-capabilities.json`
- `wrangler.jsonc`

Provision the Cloudflare resources referenced by the installation and keep secrets out of the repository. See `docs/CONFIGURATION.md`. If the installation publishes images, follow `docs/ASSET_INTAKE_SETUP.md` as well; the environment table alone is not enough to make image operations work.

## 3. Replace the reference website

Treat the included Example Company site like a starter theme. Replace the branding, pages, layout, components, copy, and images with the real client site.

The included design is not a framework restriction. It is only a readable reference implementation.

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

## 7. Wire the GitHub-to-Worker dispatch

Use `docs/DISPATCH_REFERENCE.md` as the minimal reference. Replace it when necessary for the installation, but preserve validation and the controlled Worker mutation boundary.

## 7b. Hand the operator its instructions

Copy `ai/OPERATOR_SETUP.md` into the ChatGPT project's instructions with the placeholders filled in, and edit `ai/OPERATION_POLICY.md` for this site.

These are not optional polish. During the first production use of this system the code did not change once, and the operator's behaviour still changed four times purely because of how these were written. `ai/README.md` explains which rule belongs in which file and why they cannot be merged.

## 8. Verify the real installation

Before client handoff, verify at least one ordinary text/content operation and one image-bearing operation against the actual provisioned installation.

The repository does not need to pre-prove every downstream client environment. Each implementer proves the installation they deliver.

## Definition of done for an implementer

The implementation is ready for handoff when:

- the repository installs and verifies cleanly
- client-owned Cloudflare/GitHub/asset infrastructure is configured
- the reference design has been replaced as needed
- required site areas have explicit capabilities
- representative commands work end to end
- the client can make routine updates from ChatGPT without operating the infrastructure directly

Anything beyond that is project-specific hardening, not a requirement for using this repository as a base.
