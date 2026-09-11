# Forks and upstream

This repository is canonical. Client work happens in forks. Without a rule for
what moves back, the two copies drift until the fork becomes a second,
undocumented implementation.

```text
chatgpt-operated-site        canonical, English, public
  ├── fork: demo site        generic content, where new work is proven
  └── fork: client project   one private fork per client
```

## What a fork is expected to override

1. `config/site-profile.json` — site identity and intake configuration
2. `wrangler.jsonc` — binding ids for that account
3. `ai/OPERATION_POLICY.md` — the operating policy for that site
4. site-specific content, styles and copy

**Anything else a fork has to override is a gap in the baseline.** That is the
whole test for "does this belong upstream", and it is worth applying early: a
fork that quietly fills a hole stops seeing it as a hole.

This has already cost something. The reference site shipped without a route to
render the articles its own commands create. The first client fork built its own
routes on day one, so the fork was fine and the baseline stayed broken for
another two days. Nobody was deceived; the question simply was not asked.

Ask it about anything you add to a fork: **is this the client's site, or is this
something that was missing?**

## Moving a capability upstream

1. Develop and prove it in the fork.
2. Generalize it — remove the client's names, vocabulary, and assumptions.
3. Port it upstream, in English, with an explanation of why it exists.
4. **Remove it from the fork.**
5. Let the fork take it back by pulling.

Step 4 is the one that gets skipped, and skipping it is how drift starts: two
implementations of the same thing, diverging quietly, until a bug fixed in one
reappears in the other.

## Records

Findings from client work stay in the fork, with the evidence that produced
them. Upstream receives the generalized change and an English explanation.

The record of *how* something was discovered belongs where the discovery
happened. The change belongs where everyone can use it.

## Verifying a port

Porting is not finished when the code compiles in the canonical repository.
Run it. The two defects most recently found upstream — a renamed command file
slipping past the dispatch gate, and the first push of a branch replaying the
whole operation log — were both in code that had run in production for days.
The fork had simply never met those conditions.

A port is proven on a disposable installation, not in the fork it came from.
`docs/QUICK_START.md` is how to build one.
