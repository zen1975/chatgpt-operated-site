# GitHub Actions Dispatch Reference

This repository ships one small, replaceable reference adapter from a committed
Command JSON file to the Worker. It is the supported starter path, not the only
possible integration architecture.

## Golden path

1. Add a command JSON file that matches the current envelope and payload schema.
2. Commit the file. The workflow reads the blob at `HEAD`, not a working-tree copy.
3. Run **Dispatch Site Command** with its repository-relative path.
4. Keep `dry_run` enabled for the first run.
5. After the dry run succeeds, run it again with `dry_run` disabled.

The adapter performs a deliberately short sequence:

```text
committed command
  -> local schema, rule-version, and target-site checks
  -> configured provider readiness when a new provider reference is present
  -> authenticated Worker preflight and receipt binding
  -> authenticated Worker dispatch
```

The Worker remains authoritative for authentication, authorization, schema and
capability rules, optimistic versioning, idempotency, and mutation. Replacing
GitHub Actions must not remove those Worker checks.

## GitHub environment

Create a protected environment named `site-operations`.

| Name | Kind | Purpose |
| --- | --- | --- |
| `SITE_ENDPOINT` | Environment variable | Deployed site origin, such as `https://site.example.com`. |
| `CONTROL_READ_HMAC_SECRET` | Environment secret | Signs readiness and preflight requests. |
| `COMMAND_HMAC_SECRET` | Environment secret | Signs the final mutation request. |

Configure required reviewers on the environment when human approval is part of
the installation's operating policy. Never commit these values.

The workflow appears in the Actions UI only after its file exists on the default
branch. Before that, its tests run normally in the pull request.

## Image references

Readiness is required only when a command carries a new provider reference. A
canonical `assetId` already names an ingested asset and does not require Asset
Intake readiness.

The starter recognizes provider references on the three schemas that currently
accept them: `replace_asset`, `replace_product_asset`, and
`replace_page_section_asset`. Their provider must match
`config/site-profile.json`. When adding another reference-bearing command or
provider, extend the schema, adapter hook, documentation, and tests together.

`context.requiresAssetIntake` remains accepted for compatibility and as useful
operation metadata, but the dispatch adapter derives readiness from the
validated payload rather than trusting that flag.

## Boundaries

- The workflow accepts one committed JSON file; it does not accept inline JSON.
- Absolute paths, traversal, directories, symlinks, and uncommitted files are rejected.
- A preflight receipt is short-lived evidence, not permission to bypass Worker checks.
- The included path is CI-tested. A disposable deployed-environment run and an
  actual ChatGPT-to-site acceptance run remain release acceptance steps.
- Other orchestrators may replace Actions if they preserve the same signed
  Worker contracts and fail closed on validation or preflight errors.
