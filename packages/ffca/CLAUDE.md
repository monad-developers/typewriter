# CLAUDE.md — ffca

Instructions for agents working on `packages/ffca`.

## What this package is

`ffca` ("framework for crypto apps") is a generic framework being extracted from `apps/order-book-backend`. The order book is the first consumer. The package itself must not contain any order-book-specific code.

## Motivations

ffca exists to push what crypto app experiences can be, by giving ambitious teams a foundation to build on. Applications are the fundamental unit to optimize for: they define the requirements that everything below them — sequencing, accounts, confirmations, settlement — has to answer to.

## Beliefs

What we believe that makes ffca different.

- **Compete on technical merit, not ideology.** The next generation of crypto apps will be defined by what works, not by adherence to existing camps.
- **Blockchains are the database, not the backend.** They occupy the persistence layer of the stack; everything else — sequencing, validation, application logic — lives above them.
- **Write logic once.** Contract and backend shouldn't duplicate the same logic in two places. Pick one home for each piece and let the other defer to it.
- **Distillation over invention.** Reducing existing ideas to their simplest form does more for the framework than inventing new ones.

## Feedback loops

High-level signals for whether ffca is on the right track. None are precisely measurable; they're the lenses to evaluate work through.

- **AI legibility.** Can an agent read this codebase and understand the motivations and decision-making behind it well enough to make good calls? If an agent has to guess at intent, the docs or the code are failing.
- **Focus.** Are the ideas distilled to their simplest possible form? Every added concept dilutes the surface; the bar for introducing one should be high.
- **Developer experience.** Deployment, environment setup, and modularity should feel simple and composable — small pieces that snap together, with the developer ultimately in control.
- **Performance.** Transaction latency and gas costs. The ceiling ffca raises is partly a performance ceiling — slow or expensive paths cap what apps can be.

## Status

Scaffolded but empty. `createFFCA` is a stub. Nothing imports from it yet.

## Working in this package

- **Don't add speculative surface.** Every exported type, function, and config field must have a real call site that needs it. If nothing in the order-book backend (or another consumer) calls it, delete it. We'll build the surface up one extraction at a time.
- **Don't write README/doc sections ahead of code.** Document features after they work, not before.
- **The README is evidence, not argument.** It should describe what ffca is and does so readers can draw their own conclusions about why it's impactful. Don't editorialize or make the case for the framework in it.
- **Don't leak order-book vocabulary.** No mention of `instrument`, `order`, `fill`, `tick`, etc. in ffca code. If a concept feels generic but the only example is order-book, it probably isn't generic yet.
- **Prefer ox over viem.** See root `CLAUDE.md`.
