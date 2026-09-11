# Requests from the requester

When the person operating the site asks for something that cannot be done
today, it is recorded here. Nothing in this directory triggers anything: no
workflow watches it, and committing a file here does not change the site.

That is the point. It is a place to put a thought without it becoming an
action.

## Where a record goes

```text
feedback/<YYYY>/<MM>/<YYYYMMDD-HHMM>-<short-name>.md
```

## What a record contains

```markdown
# <one line naming the request>

Date: <YYYY-MM-DD HH:MM>

## What they said

> <their own words, quoted, not summarised>

## Context

<what they were doing when it came up>
```

## Record their words, not your reading of them

Do not condense, and do not add an assessment. A record that says "probably low
priority" has already made the decision, and it made it without the people who
should be making it.

The small remarks are the ones that matter. If recording something takes
effort, the small remarks never get recorded, and those are exactly the ones
that decide whether a site keeps being maintained.

## What happens next

Someone on the site team reads these. If something is built as a result, tell
the requester through `ai/announcements.json`, so the loop closes where it
started.
