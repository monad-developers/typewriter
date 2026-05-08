# CLAUDE.md — ffca

Instructions for agents working on `packages/ffca`.

## What this package is

`ffca` ("framework for crypto apps") is a generic framework being extracted from `apps/order-book-backend`. The order book is the first consumer. The package itself must not contain any order-book-specific code.

ffca is a framework, not a runtime that adapts to arbitrary contracts. It prescribes the shape of the contracts that use it — execution surface, storage layout conventions, event conventions — so that the runtime, decode layer, and tooling above it can be sharp and opinionated rather than defensive. Conformance is the API.

## Motivations

ffca exists to push what crypto app experiences can be, by giving ambitious teams a foundation to build on. Applications are the fundamental unit to optimize for: they define the requirements that everything below them — sequencing, accounts, confirmations, settlement — has to answer to.

## Beliefs

What we believe that makes ffca different.

- **Compete on technical merit, not ideology.** The next generation of crypto apps will be defined by what works, not by adherence to existing camps.
- **Blockchains are the database, not the backend.** They occupy the persistence layer of the stack; everything else — sequencing, validation, application logic — lives above them.
- **Write logic once.** Contract and backend shouldn't duplicate the same logic in two places. Pick one home for each piece and let the other defer to it.
- **Focus compounds.** Outcomes follow a power law, so doubling down on the core idea beats spreading thin across adjacent ones. Every new surface dilutes the one that matters.
- **Pragmatism over assembly.** Everything ffca enables is technically possible today by stitching together L2 rollups, account abstraction providers, and other middleware. ffca delivers the same results without the cruft.

## Feedback loops

High-level signals for whether ffca is on the right track. None are precisely measurable; they're the lenses to evaluate work through.

- **AI legibility.** Can an agent read this codebase and understand the motivations and decision-making behind it well enough to make good calls? If an agent has to guess at intent, the docs or the code are failing.
- **Focus.** Are the ideas distilled to their simplest possible form? Every added concept dilutes the surface; the bar for introducing one should be high.
- **Developer experience.** Deployment, environment setup, and modularity should feel simple and composable — small pieces that snap together, with the developer ultimately in control.
- **Performance.** Transaction latency and gas costs. The ceiling ffca raises is partly a performance ceiling — slow or expensive paths cap what apps can be.

## Status

~720 lines across config, types, runtime, eip712, encoding. End-to-end against anvil. The runtime drains a mutation queue, sorts by `config.sequence`, runs `resolve` then `apply` per mutation against a structuredClone-based snapshot (revert on throw), then submits bundles via simulate → access list → estimate → sign → broadcast → block lookup. EIP-712 typed-data verification (state-independent half) is wired. Calldata is `(uint8[] tags, bytes[] mutationData, bytes[] signatures)[]` where each `signatures[i]` is the ABI-encoding of one structured signature against the app-supplied `FFCAConfig.signature.params`. Event fan-out via `on(event, cb) → unsubscribe` for mutation/bundle/block. 27 tests including 5 e2e against a real chain. No persistence, no watch loop, no authorize hook, no native signature verifiers.

## Tests

`bunfig.toml` preloads `test/setup.ts`, which compiles the test contracts (`test/contracts/`), boots anvil via `prool` on port 8545, creates an isolated Postgres database per test from `DATABASE_URL`, and registers a global `beforeEach` that snapshot-reverts chain state between tests. Each test deploys its own contracts via `deployCounter` / `deployHarness` from `test/utils.ts` — there's no shared deployment to remember.

Run ffca tests from `packages/ffca` (`bun test`) or through the workspace script
(`bun run --filter ffca test`). Do not run `bun test packages/ffca` from the repo
root: that does not load `packages/ffca/bunfig.toml`, so the preload hooks can
tear down Anvil/Postgres before later files run.

If broad test runs fail during setup, run `DATABASE_URL=postgres://postgres@localhost:5432/postgres bun test packages/ffca/test/setup.test.ts` first to isolate Anvil/Postgres environment failures before debugging app logic.

## Roadmap

The frame: every change is purpose-built for making it easier to build apps with ffca, or for making the apps built better. Apps come first; the framework follows them. The goal is to port `apps/order-book-backend` onto ffca and have it back to demo-grade reliability — knowing the ffca-backed version will be temporarily worse than what it replaces.

### Lanes

The work catalog. Non-sequenced — items in different lanes can run in parallel.

**1. Missing implementation.** Things that are part of the framework but aren't there yet.
- Watch loop + reorg handling
- Force inclusion
- Signed receipts / client-side equivocation proving
- Alternative sequencing (FIFO and beyond)
- Authorize hook + native signature verifiers (P-256, WebAuthn-P256, secp256k1). Wire-format codec is in place — apps declare `signature.params` and ffca ABI-encodes structured signatures into `bundle.signatures[]`. See `PLAN_account.md`.
- Persistence hooks
- Backpressure on the mutation/submit queues

**2. Production readiness.** Hardening for running real apps.
- Effect.ts usage for HTTP and DB handlers
- Shutdown testing (deterministic drain)
- Nonce recovery on conflict
- Scheduler KMS / better account system
- Recovery from submit-fiber crashes (today: `Effect.orDie`)

**3. Developer experience.** Usability — make the framework feel small and composable.
- State sync (granular slot subscriptions; falls out of revm)
- Type inference from contracts (extract mutation and state types from Solidity)
- AST parsing for conformance + runtime values (validate contract shape, extract EIP-712 domain automatically)
- Zod schemas for HTTP endpoint enforcement
- Automatic deployment management (no copying addresses into env vars)
- CLI scaffolding (`ffca dev` with anvil + fixture contract)

**4. Documentation.** Someone should be able to read the docs and form a clear picture of how ffca works. Today it's almost empty.
- Architecture diagram (mutation → bundle → submit → watch + the four loops)
- "What ffca prescribes vs. what the app owns" matrix
- Migration / port playbook (evergreen output of the order-book port)

### Initiatives

Multi-week projects that span lanes. Each has its own internal sequence.

**revm as the server execution engine.** The biggest single change. Replaces the TS reimplementation of contract logic with the actual EVM bytecode running locally — the contract becomes the spec instead of a thing to keep in sync by hand. Subsumes failure isolation (free state revert), changes persistence shape (raw slots in memory + decoded tables for the consumable layer), and unlocks state-sync. Decoding mappings-of-structs and dynamic arrays is the hard part. Tracked in the background; doesn't gate the one-week port.

**Account model.** ffca has no concept of accounts/keys/nonces today. The order-book contract demands one specific shape (32-byte account ids, key registry with P-256/WebAuthn/secp256k1, parallel nonces by `(account, keyIndex)`). The signature codec is the symptom; the underlying design call is whether ffca *prescribes* this model (every ffca app gets it) or exposes it as an *interface* (apps plug their own in). The decision needs more contract iteration before it can be made — see Open decisions.

**AST + storage-layout codegen.** A lot of what the backend currently hand-authors could be read from the contract instead — bundle tuple shape, mutation tag enum, per-mutation param ABI, EIP-712 domain, state shape, event ABI, error selectors. Mechanics are `forge build`'s AST and `forge inspect storageLayout`. TS can't read those at type-check time, so typed access requires codegen as a derived artifact. Runtime behavior (encoding, tag mapping, layout reads) can come straight from the contract without codegen.

**Scheduler key management.** Today `FFCAConfig.account: PrivateKeyAccount` is in-process key material — fine for dev, a footgun for production. Three pieces share the same seam (the framework's signing identity): KMS / remote signer support, nonce recovery on conflict, and user-shaped signing on-contract (scheduler key in the same registry as user keys, with rotation/expiry/scopes).

### This week (sequenced)

The active sequence. Demo-grade reliability by end of week.

1. **Account model decision.** Prescribed vs. interface. Blocked on more contract iteration.
2. **Watch loop.** ~80 lines. Polls latest block, advances proposed → voted → finalized → verified by configurable confirmation depth. Account-agnostic; can land before #1.
3. **Signature codec.** Falls out of #1 — once `account`/`keyId` are ffca concepts, the wire format is mechanical.
4. **Order-book port.** Replace `apps/order-book-backend/src/runtime.ts` with `createFFCA` + listeners. App keeps DB, HTTP, signature verification, nonces.
5. **Demo-readiness sweep.** Backpressure, deterministic shutdown, timing logs, remove `process.exit(1)` from the fiber-died handler.

### Open decisions

Forks that gate sequencing. Listed so they don't get rediscovered every session.

- **Account model: prescribed vs. interface.** Does ffca ship with the order-book account model as the default (every ffca app gets 32-byte ids + key registry + parallel nonces), or does it expose an interface and apps plug in (EOAs, custom key types, etc.)? Needs more contract iteration before it can be answered.
- **Persistence shape.** Decoded tables (the order-book pattern: typed Postgres rows the app GETs directly) vs. raw `(slot, value)` storage with decoders on top (the revm-native pattern). Tentatively leaning decoded — the consumable layer needs to be human-readable either way, and revm's in-memory state is the runtime source.
- **Resolution language.** Off-chain matching is settled. Open question: is the resolution itself written in TypeScript (today's order-book) or in Solidity (a view function the runtime calls)? Solidity-side resolutions remove the TS/Sol drift but are gas/perf-sensitive and harder to debug.

## Working in this package

- **Don't add speculative surface.** Every exported type, function, and config field must have a real call site that needs it. If nothing in the order-book backend (or another consumer) calls it, delete it. We'll build the surface up one extraction at a time.
- **Don't write README/doc sections ahead of code.** Document features after they work, not before.
- **The README is evidence, not argument.** It should describe what ffca is and does so readers can draw their own conclusions about why it's impactful. Don't editorialize or make the case for the framework in it.
- **Don't leak order-book vocabulary.** No mention of `instrument`, `order`, `fill`, `tick`, etc. in ffca code. If a concept feels generic but the only example is order-book, it probably isn't generic yet.
- **Prefer ox over viem.** See root `CLAUDE.md`.
