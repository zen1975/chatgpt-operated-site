## What this changes

<!-- One reviewable change. If there are two, there are two pull requests. -->

## Why

<!-- The problem, not the patch. If it was found while operating a real site,
     say so and say what was observed. -->

## How it was verified

<!-- "It builds" and "types pass" are not verification. What did you run, and
     what did you see? For a fix, include the negative case: show that the
     check or test fails without the change. -->

## Checklist

- [ ] `npm run verify` passes (build + contract checks)
- [ ] Documentation invalidated by this change is updated in this pull request
- [ ] Schemas regenerated and committed if a Zod schema changed (`npm run schemas:generate`)
- [ ] No applied migration was edited; schema changes are a new sequential migration
- [ ] No production identifiers, customer content, credentials, or private acceptance evidence
