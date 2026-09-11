# Operation policy

This file is a template. Edit it for the installation and commit it. It is one
of the four files a fork is expected to override.

The operator reads this from the repository, so it holds rules about **the work
itself**. Rules that must be in force before this file is read belong in
`ai/OPERATOR_SETUP.md`.

---

## Scope

<What this site publishes, and what it does not. Name the content types that
exist and what each one is for. An operator that does not know the difference
between a news item and an article will guess, and it will guess consistently
wrongly.>

## Current state versus past record

`state/content-index.json` and `state/page-index.json` hold the current ids and
versions. `state/bodies/*.json` holds the current body of each item.

Files under `commands/` are a record of operations that already ran. An id or
an `expectedVersion` taken from there is stale, and the update will be rejected
on the version check.

Never reconstruct an existing body from the published page. Rendering drops
things that the stored body keeps, and an update built from the rendered page
loses them permanently.

## Decide the object first, then create or update

Two questions, in this order. **What kind of thing is being changed**, and
**does it already exist.**

`src/server/command-schema.ts` is the authority for which command each object
takes. The rules below cover news and articles only.

| The object | Create | Change |
| --- | --- | --- |
| a news item or an article | `create_news` | `update_content` |
| a page, or a section of a page | `create_page` | `update_page`, `update_page_section`, and the section-item commands |
| a product | `create_product` | `update_product` |

A request about the homepage, a section, or a product is **not** an
`update_content`. Sending one either fails validation or targets the wrong
object. Read the schema for that object instead.

For news and articles: adding something new is `create_news`. Changing
something that exists is `update_content`, and it needs the `contentId` and
`expectedVersion` from `state/content-index.json`.

"Change X to Y" is a replacement, not an addition. When the requester names an
item that already exists, it is an update.

## How to report back to the requester

Report what you registered and where it is published. Ask them to look at the
page. Do not describe the machinery.

State the outcome plainly. A command that succeeded is done; a command that
failed is not. Do not report a failure for an operation that succeeded, and do
not report success without the URL that proves it.

## Stop only on failure

If validation, readiness, a version check or dispatch fails, stop and report
which stage failed and its error code.

Do not retry with altered values to get past a rejection. A version conflict
means someone else changed the item: re-read `state/` and start again.

## Vocabulary the requester uses

<Map the words this client actually uses to the operations they mean. This is
the section that most reduces mistakes, and it can only be written after
listening to them. For example:>

| They say | They mean |
| --- | --- |
| "put up a notice" | create_news, contentType news |
| "write up the job we did for X" | create_news, contentType article |
| "take it down" | archive_content |
| "fix the wording" | update_content |

## Categories

<Which taxonomy terms exist, and how to choose between them. If the operator
may not create new terms, say so here.>

## URLs

<The permalink scheme, taken from config/permalink-profile.json. The operator
hands these URLs to the requester, so they have to be right.>

## Writing style

<House style: length, headings, tone, what to avoid. Be concrete. "Write
clearly" changes nothing; "break the text with a heading every three or four
paragraphs" does.>

## Images

<Where images come from for this installation. If Google Drive is configured,
describe the intake folder and that the operator passes the Drive file id as
`providerAssetId`. See docs/ASSET_INTAKE_SETUP.md.>

Any command that introduces a new provider-backed image must carry the
operation metadata that says so:

```json
"context": {
  "ruleVersion": "...",
  "targetSite": "...",
  "requiresAssetIntake": true
}
```

It belongs on `create_news` with an `assets` array just as much as on
`replace_asset`. The dispatch adapter derives readiness from the reference
itself and does not depend on this flag, but the flag is the declared contract
for the operation, and examples are copied.

A command that uses an existing `assetId` rather than a provider reference does
not need it: nothing new is being taken in.

## Announcements from the site team

`ai/announcements.json` holds notices for the requester. The operator delivers
any notice whose date range covers today at the start of a conversation, in the
shape fixed by `ai/OPERATOR_SETUP.md`.

Write the body exactly as the requester should hear it. The operator passes it
through word for word.

## Requests from the requester

`feedback/README.md` describes where to record something the requester asks for
that cannot be done today.

Record their own words. Do not summarise, and do not add an assessment. The
moment a recorded request says "probably not needed", the decision has moved
from you to the operator.
