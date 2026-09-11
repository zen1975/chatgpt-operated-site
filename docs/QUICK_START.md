# Quick Start

From a clean clone to a live site that publishes an article when you push a
file. Roughly thirty minutes, most of it waiting on Cloudflare.

Every step here was run against a disposable installation. Where a step has a
failure that people actually hit, the failure is named.

## Requirements

- Node 22.23.2 (pinned in `package.json` engines; Wrangler 4 requires Node 22+)
- A Cloudflare account
- Wrangler, authenticated: `npx wrangler login`

## 1. Prove the baseline before configuring anything

```bash
npm ci
npm run verify
```

`verify` is a build plus the contract checks. It must pass on an unmodified
clone. If it does not, stop here: nothing later will be easier to diagnose.

## 2. Create the infrastructure

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>

npx wrangler d1 create <name>-content
npx wrangler kv namespace create <name>-session
npx wrangler r2 bucket create <name>-assets
```

Each command prints an id. **Write all three into `wrangler.jsonc` yourself.**
Auto-provisioning does not write them back, and without them the second
`--remote` operation fails with `missing database_id`.

Replace in `wrangler.jsonc`:

| Placeholder | Value |
| --- | --- |
| `replace-me-chatgpt-operated-site` | the Worker name |
| `replace-me-content` / `database_id` | the D1 name and the printed uuid |
| `replace-me-assets` | the R2 bucket name |
| the zeroed KV `id` | the printed namespace id |
| `SITE_ORIGIN` | the URL the site will answer on |

## 3. Apply the migrations

```bash
npx wrangler d1 migrations apply DB --remote
```

## 4. Set the two secrets

They are shared between the Worker and whatever dispatches to it, so generate
each value once and send the same value to both places. `.dev.vars` is
git-ignored and is what lets you dispatch from your own machine while setting
up.

```bash
node -e "
  const { randomBytes } = require('crypto');
  const line = (n) => n + '=' + randomBytes(32).toString('hex');
  require('fs').writeFileSync('.dev.vars',
    [line('COMMAND_HMAC_SECRET'), line('CONTROL_READ_HMAC_SECRET'), ''].join('\n'));
"

set -a; . ./.dev.vars; set +a
printf '%s' "$COMMAND_HMAC_SECRET"      | npx wrangler secret put COMMAND_HMAC_SECRET
printf '%s' "$CONTROL_READ_HMAC_SECRET" | npx wrangler secret put CONTROL_READ_HMAC_SECRET
```

`printf` rather than `echo`: a trailing newline becomes part of the secret, and
every signature then fails with an error that says nothing about newlines.

Never commit these, and never paste them into chat or email. The same two
values go into the GitHub environment in step 8.

## 5. Deploy

```bash
npm run deploy
```

Open the printed URL. The reference site should render. On a brand-new Worker
the `workers.dev` route can take a few seconds to appear; a 404 immediately
after the first deploy usually resolves on its own.

## 6. Publish one article

A command must be a committed blob, not a working-tree file — the dispatcher
reads it at `HEAD`.

```bash
DIR=commands/$(date +%Y)/$(date +%m)
mkdir -p "$DIR"
cp examples/commands/create-news.json "$DIR/first.json"
# edit it: give it a commandId that has never been used, and your own title,
# slug and blocks
git add commands && git commit -m "first command"
```

Then validate, rehearse, and dispatch:

```bash
export SITE_ENDPOINT=<the deployed URL>
set -a; . ./.dev.vars; set +a

node scripts/validate-commands.mjs commands
node scripts/dispatch-command.mjs --command-file "$DIR/first.json" --dry-run
node scripts/dispatch-command.mjs --command-file "$DIR/first.json"
```

The result carries the URL. **Open it.** A successful dispatch is not a
completed operation; the rendered page is.

```bash
curl -s -o /dev/null -w "%{http_code}\n" "<site>/news/<slug>/"
```

## 7. Publish the current ids back into the repository

```bash
node scripts/refresh-state-index.mjs
git add state && git commit -m "state"
```

It needs the read scopes `content:read` and `page:read`, which are in the
default `CONTROL_READ_SCOPES`. If you trimmed that list, put them back.

This writes `state/content-index.json`, `state/page-index.json` and
`state/bodies/`. Updates need the `expectedVersion` recorded there. Without it
the only numbers available come from `commands/`, which is a log of past
operations, and every update fails on the version check.

## 8. Make pushing a file enough

So far you have run the dispatcher by hand. `.github/workflows/process-command.yml`
does it on push, which is what makes the system operable by someone who is not
you.

1. Push the repository to GitHub.
2. Create an environment named `site-operations`.
3. Add the variable `SITE_ENDPOINT`.
4. Add the secrets `COMMAND_HMAC_SECRET` and `CONTROL_READ_HMAC_SECRET`, the
   same values the Worker has.

Commit a new command and push it. The workflow collects it, rejects duplicates,
validates it, dry-runs the batch, dispatches, and commits the refreshed state
index back.

Two things to know before you rely on it:

- The **first push of a branch** dispatches nothing on purpose. It is a
  repository bootstrap, not an operation.
- `commands/**` is an immutable log. Editing, renaming or deleting a command
  file fails the run by design.

On a private repository this consumes your GitHub Actions minutes. Public
repositories run Actions for free.

## 9. Images (optional)

Skip unless the installation publishes images. Image intake needs its own
provisioning, and the environment table in `docs/CONFIGURATION.md` is not
enough on its own — follow `docs/ASSET_INTAKE_SETUP.md`. The step people miss
is sharing the intake folder with the identity the credential belongs to.

Once it is configured, an image travels with the content that uses it:
`create_news` takes an `assets` array, so one command publishes the article and
its picture. See `examples/commands/create-news-with-image.json`.

## 10. Hand it to the operator

The client talks to ChatGPT, not to any of the above.

1. Paste `ai/OPERATOR_SETUP.md` into the ChatGPT project's instructions, with
   the placeholders filled in.
2. Edit `ai/OPERATION_POLICY.md` for this site and commit it.

`ai/README.md` explains why those two files cannot be merged into one.

## Done means three things

```text
1. The dispatch succeeded
2. The rendered site shows the requested state
3. What the operator told the requester matches 1 and 2
```

The third is not decoration. The operator is the only surface the client sees,
and a correct system that reports incorrectly has not delivered anything.
