# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities through GitHub's private vulnerability
reporting on this repository ("Security" → "Report a vulnerability"). Please do
not open a public issue for an unfixed vulnerability.

Include the affected version or commit, the impact, and a minimal reproduction.
Please do not include real credentials, customer data, or production
identifiers in a report.

## Scope

This repository is a starter that installers deploy into their own Cloudflare
and GitHub accounts. Security-relevant areas of the starter itself:

- the command ingress endpoints and their HMAC verification
- the trusted authorization scope boundary in `src/server/commands.ts`
- the read control plane under `/api/control/*`
- Asset Intake credential handling and readiness reporting
- the schema boundary that keeps natural-language intent from becoming
  arbitrary SQL, HTML, or application-state writes

A misconfigured installation — committed secrets, `*` scopes, placeholder
identifiers left in place — is the installer's responsibility, but reports
about defaults that make misconfiguration likely are in scope and welcome.

## Design expectations

Contributions to this repository are expected to preserve the following. These
are enforced by `npm run test:contract` where they can be, and by review where
they cannot.

- **Signature comparison is constant-time.** Never compare an HMAC with `===`
  or `!==`. Use the constant-time helper each ingress already defines.
- **Signatures are time-bounded.** Every signed request carries a timestamp and
  is rejected outside a 5-minute window, so a captured request cannot be
  replayed indefinitely.
- **Missing secrets fail closed.** An unconfigured endpoint returns an error;
  it never falls back to unauthenticated access.
- **Authorization precedes work.** Scope checks run before payload validation,
  provider fetches, and storage access.
- **Commands are validated against the schema, not trusted.** Every payload
  passes its Zod schema before any mutation. There is no path that accepts
  arbitrary SQL, HTML, or JSON-patch input from the operator.
- **Credential values are never returned or logged.** Readiness checks report a
  verdict and a code, never the credential.
- **No secrets in the repository.** Real identifiers and credentials belong in
  Cloudflare Workers Secrets. `npm run test:contract` scans tracked files for
  credential-shaped content and for production identifiers committed in place
  of the shipped placeholders.

## Supported versions

This project has not yet cut a stable release. Until it does, only the current
`main` receives security fixes.
