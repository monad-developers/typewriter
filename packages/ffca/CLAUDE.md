# CLAUDE.md — ffca

Instructions for agents working on `packages/ffca`.

## What this package is

`ffca` ("framework for crypto apps") is a generic framework being extracted from `apps/order-book-backend`. The order book is the first consumer. The package itself must not contain any order-book-specific code.

[TODO: add a "Motivations" section explaining why this framework exists and what problems it's trying to solve — the constraints it's designed around, the apps it's meant to support, why a framework rather than a library. Agents working in here need to understand the *why* to make good calls about scope.]

[TODO: add a "Feedback loops" section — high-level, project-wide. How does this work get validated and refined over time? Things like: how do we know we're building the right abstractions, when do we revisit decisions, what signals tell us a piece of the framework is wrong, how does the order-book consumer drive ffca's design vs. ffca constraining the consumer. The shape of the design conversation, not the build commands.]

## Status

Scaffolded but empty. `createFFCA` is a stub. Nothing imports from it yet.

## Working in this package

- **Don't add speculative surface.** Every exported type, function, and config field must have a real call site that needs it. If nothing in the order-book backend (or another consumer) calls it, delete it. We'll build the surface up one extraction at a time.
- **Don't write README/doc sections ahead of code.** Document features after they work, not before.
- **Don't leak order-book vocabulary.** No mention of `instrument`, `order`, `fill`, `tick`, etc. in ffca code. If a concept feels generic but the only example is order-book, it probably isn't generic yet.
- **Prefer ox over viem.** See root `CLAUDE.md`.
