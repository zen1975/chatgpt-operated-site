# Operator instructions

The operator is the ChatGPT account the client talks to. These files are what
tell it how to behave. They ship with the baseline, like the schemas do,
because **correct code with absent or badly placed instructions does not
produce a working installation.**

During the first production use of this system the code did not change once,
and the operator's behaviour still changed four times purely because of how
the instructions were written. It generated images nobody asked for. It
explained repositories and schemas to a non-technical client. It treated a
question ("what if I want an image?") as an instruction to act. It answered
before reading the repository, so pending announcements were skipped.

## The two locations are not interchangeable

| File | Where it goes | What belongs in it |
| --- | --- | --- |
| `ai/OPERATOR_SETUP.md` | Pasted into ChatGPT's custom/project instructions | Rules that decide **the shape of the reply**: who is being addressed, what vocabulary is forbidden, what must be read before answering, what must never be started |
| `ai/OPERATION_POLICY.md` | Stays in the repository | Rules that decide **the content of the work**: how to structure an article, which command to use, what the URL scheme is |

The test is **when the rule has to take effect**, not whether it is a
prohibition:

> If the rule must already be in force before the repository is read, it
> belongs in the pasted setup text. Everything else belongs in the repository.

This was learned the expensive way. Three separate rules were first written
into the repository, ignored, and only took effect once they were moved into
the pasted text. A rule the model needs *while deciding how to answer* cannot
live in a file it reads *after* deciding to work.

## Installing them

1. Copy `ai/OPERATOR_SETUP.md`, replace every `<...>` placeholder, and paste the
   result into the ChatGPT project's instructions.
2. Edit `ai/OPERATION_POLICY.md` for the installation and commit it. It is one
   of the four files a fork is expected to override.
3. Keep `ai/announcements.json` in the repository. It is how you speak to the
   client through the operator.
4. Keep `feedback/` in the repository. It is how the client speaks back.

## Instruct for quality. Enforce for consequences.

Everything here is instruction, and instructions get broken. Over four days of
real operation, instructed rules were broken four times and boundaries enforced
by the application were never broken.

So do not write an instruction for anything whose violation causes real harm.
If a new rule matters that much, put it in the application and leave a note here
saying where it lives.

Know which of the two you are relying on. **Showing the client a draft and
waiting for approval is instructed, not enforced.** The default installation has
no approval field and no approval check: `process-command.yml` dispatches every
newly pushed command, and a GitHub environment reviewer is optional. An operator
that ignores the instruction publishes, and nothing stops it.

That is a deliberate position for a baseline, not an oversight, and it is stated
here so nobody mistakes the instruction for a guarantee. An installation that
needs approval to be binding has to enforce it -- a required environment
reviewer on the dispatch job is the smallest version. Until then, do not
describe it to a client as something the system will not let them skip.

Enforced, by contrast, are the boundaries the application owns: a command that
fails validation is not applied, a repeated `commandId` applies nothing, a
version conflict stops the write, and an unauthorized scope is refused before
any mutation.

## Language

These are English templates. A localized policy for one installation is an
example, not the reference. Keep the canonical copies in English.
