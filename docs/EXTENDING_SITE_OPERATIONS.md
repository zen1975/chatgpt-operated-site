# Extending Site Operations

The Astro site included in this repository is a reference implementation, not a fixed list of editable areas.

The intended model is that a developer can make any appropriate part of a client website operable from ChatGPT by adding an explicit, tested capability to the application.

## Core rule

Do not give ChatGPT unrestricted write access to HTML, SQL, JSON, or application state.

Instead, expose a controlled operation:

```text
Natural-language request
  -> allowed capability
  -> validated command schema
  -> deterministic handler
  -> revision / job / projection
  -> rendered website
```

ChatGPT is the operator. Application code owns the rules and reproducibility.

## Example: make an announcement bar operable

Suppose a client wants to say:

```text
"Show an announcement that our office will be closed on Monday."
```

A developer can add that capability using the following pattern.

### 1. Define the target state

Decide exactly what the site stores and renders. For an announcement bar this might include:

- enabled
- message
- optional link label
- optional link URL

Avoid treating arbitrary markup as the state contract.

### 2. Define the command

Add a narrow command such as `update_announcement_bar` with a schema that accepts only the fields the operation needs.

The schema is the boundary between natural-language intent and application mutation.

### 3. Declare the capability

Make the operation available only where the site policy permits it. Page or component capabilities should describe which operations and section types are allowed.

### 4. Implement deterministic behavior

Add a handler that performs the exact application mutation for the validated command.

The handler — not the LLM — decides how state is written, versioned, validated, and projected.

### 5. Render the state in Astro

Connect the stored/projected state to the appropriate Astro component. The visual component can be replaced or redesigned without changing the natural-language operation contract unnecessarily.

### 6. Add tests

At minimum, test:

- valid command acceptance
- invalid payload rejection
- capability rejection where the operation is not allowed
- deterministic mutation result
- expected projection/rendering behavior
- version/conflict behavior where applicable

### 7. Add a ChatGPT operation example

Document at least one ordinary client request and the command it is expected to produce. This gives future developers and agents a concrete reference without making the example itself the structural authority.

### 8. Verify end to end

Verify the complete path from the client request through command validation and mutation to the rendered site. For image-bearing operations, verify the asset-intake path as well.

## Other operation targets

The same pattern can be used for:

- hero text and images
- navigation
- footer information
- services and product summaries
- business hours
- contact details
- cards and page sections
- FAQs
- statistics and timelines
- news and articles
- SEO and OGP metadata
- structured data
- custom components built for a specific client

## What "any part of the site" means

It means the architecture is extensible to site-specific operations. It does **not** mean every DOM node is automatically writable or that ChatGPT receives arbitrary repository or database mutation privileges.

A part of the site becomes operable when the developer intentionally defines its state, capability, schema, deterministic implementation, and tests.

That separation is what allows an agency to customize the website freely while keeping the client's ChatGPT experience simple.
