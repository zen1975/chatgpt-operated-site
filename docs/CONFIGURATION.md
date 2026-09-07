# Configuration Reference

Every value the Worker reads at runtime, and where it belongs.

Nothing on this page is a secret store. Plaintext configuration lives in
`wrangler.jsonc`; credentials live in Cloudflare Workers Secrets and are never
committed. `wrangler.jsonc` is the source of truth for bindings and `vars`:
values added only in the Cloudflare dashboard are overwritten on the next
deployment.

## Bindings

Declared in `wrangler.jsonc`. Each one must exist in the target Cloudflare
account before the first deployment.

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 database | Source of truth for content, pages, products, assets, jobs, and projections. Migrations in `migrations/` apply here. |
| `ASSETS_BUCKET` | R2 bucket | Stored asset binaries, served through `/api/assets/[key]`. |
| `SESSION` | KV namespace | Runtime key/value namespace required by the Astro Cloudflare adapter. |

The committed `wrangler.jsonc` ships deliberate placeholders
(`replace-me-*`, all-zero ids). Replace them with the installation's own
resources. `npm run test:contract` fails if a real identifier is committed in
their place.

## Plaintext variables

Declared under `vars` in `wrangler.jsonc`.

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | Absolute origin used for canonical URLs, OGP, and share links. |
| `SITE_TIMEZONE` | Timezone applied to scheduling and timed-content windows. |
| `COMMAND_TRUSTED_ACTOR` | Actor name recorded for commands arriving on the trusted ingress. |
| `COMMAND_TRUSTED_SCOPES` | Comma-separated mutation scopes granted to the trusted ingress. A command whose scope is absent is rejected before any payload validation or storage work. |
| `CONTROL_READ_SCOPES` | Comma-separated read scopes granted to the read control plane. The dispatch gate needs `command:preflight` (preflight), `intake:read` (Asset Intake readiness) and `command:read` (command claim lookup and remote identity attestation). |
| `WORDPRESS_ASSET_ALLOWED_ORIGINS` | Comma-separated origin allowlist for `import_wordpress_asset`. Not shipped in `wrangler.jsonc`: the command fails closed with `WORDPRESS_ASSET_ORIGIN_ALLOWLIST_REQUIRED` until an installation that wants WordPress import adds it. Add it to `vars` with the origins to import from, for example `https://legacy.example.com`. |

Scope names are enumerated by `MUTATION_SCOPES` in `src/server/commands.ts`.
Granting `*` disables scope separation and is not recommended for an
installation that exposes ChatGPT-driven operation.

## Secrets

Provision with `wrangler secret put <NAME>`. None of these belong in
`wrangler.jsonc`, `.env`, or the repository.

| Secret | Required | Purpose |
| --- | --- | --- |
| `COMMAND_HMAC_SECRET` | Yes | Verifies the HMAC signature on `/api/v1/commands` and `/api/internal/commands`. Without it no command can be dispatched. |
| `CONTROL_READ_HMAC_SECRET` | For control-plane reads | Verifies read requests under `/api/control/*`. When unset, the read control plane fails closed with `CONTROL_READ_AUTH_UNAVAILABLE`. |
| `READINESS_RECEIPT_HMAC_SECRET` | For provider Asset Intake | Signs and verifies Asset Intake readiness receipts. **Deliberately separate from `COMMAND_HMAC_SECRET`**: holding the command secret must not be enough to mint evidence that readiness was checked, or an authenticated caller could forge its own and bypass the readiness gate. Without it, provider intake fails closed with `READINESS_RECEIPT_UNAVAILABLE`; canonical-asset operations are unaffected. |
| `EMERGENCY_NEWS_HMAC_SECRET` | Optional | Enables `/api/emergency/news`. When unset, the endpoint fails closed with `EMERGENCY_NEWS_DISABLED`. |

### Asset Intake (Google Drive)

Only required when image-bearing operations are enabled. Configure exactly one
credential source.

| Secret | Credential source |
| --- | --- |
| `GOOGLE_DRIVE_ACCESS_TOKEN` | Static access token (shortest-lived; mainly for verification). |
| `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` | OAuth refresh-token flow. All three are required together. |
| `GOOGLE_DRIVE_SA_CLIENT_EMAIL`, `GOOGLE_DRIVE_SA_PRIVATE_KEY` | Service account. Both are required together. |

`GENERATED_ARTIFACT_ORIGIN` and `GENERATED_ARTIFACT_TOKEN` configure the
generated-artifact intake adapter and are optional.

## Keeping this page complete

This page is not maintained by hand alone. `npm run test:contract` extracts
every environment name `src/` actually reads — both `env.NAME` and the
`env as typeof env & { NAME?: ... }` widening cast — and fails when a name is
missing from `src/env.d.ts` or from this document. Adding a new runtime
configuration read to the implementation therefore breaks CI until it is typed
and documented here.

Readiness is reported by `/api/control/readiness/asset-intake/`, which returns a
verdict only and never echoes credential values. That check is owned by the
GitHub Actions dispatch gate, not by ChatGPT.

## Repository configuration

| File | Purpose |
| --- | --- |
| `config/rule-version.json` | The command rule version. Single source of truth: the Worker rejects any command whose `context.ruleVersion` differs, and the shipped examples are checked against it. |
| `config/site-profile.json` | Site identity, content types, dynamic slots, and Asset Intake declaration. `site.id` is the canonical installation identity: the Worker compares every command's `context.targetSite` against it, and the dispatch gate requires the endpoint to attest the same value. There is deliberately no second copy. |
| `config/page-capabilities.json` | Which page operations and section types are permitted per page. |
| `config/content-limits.json` | Editorial length limits mirrored by the command schemas. |
| `config/image-profile.json` | Image slot ratios and size guidance. Override per installation. |
| `config/permalink-profile.json` | URL shapes per content type. |
| `config/priority-map.json` | Named priorities for timed content. |

Files ending in `.example.json` are unmodified reference copies. Edit the
non-example file; keep the example as the documented default.

## Ingress endpoints

| Path | Authentication | Intended caller |
| --- | --- | --- |
| `/api/internal/commands` | `COMMAND_HMAC_SECRET`, 5-minute signature window | GitHub Actions dispatch |
| `/api/v1/commands` | `COMMAND_HMAC_SECRET`, 5-minute signature window | Authenticated command clients using the REST envelope |
| `/api/emergency/news` | `EMERGENCY_NEWS_HMAC_SECRET`, 5-minute signature window | Out-of-band emergency publication. Targets this installation's canonical `site.id` like any other command; its origin is recorded as the actor, not as the target site |
| `/api/control/*` | `CONTROL_READ_HMAC_SECRET`, 5-minute signature window | Read-only state, contract discovery, and command status with its recorded digest (`/api/control/commands/{commandId}`) |

The dispatch gate (`docs/DISPATCH_GATE.md`) is the supported caller of
`/api/control/preflight` and `/api/internal/commands`. It needs its own
repository-side configuration, on the `site-operations` GitHub Environment:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `SITE_COMMAND_ENDPOINT` | Origin of the deployed Worker |
| Secret | `COMMAND_HMAC_SECRET` | Must equal the Worker secret of the same name |
| Secret | `CONTROL_READ_HMAC_SECRET` | Must equal the Worker secret of the same name |

All four endpoints fail closed when their secret is absent. None of them accept
unauthenticated input, and none of them expose a path that bypasses
`executeCommand`.
