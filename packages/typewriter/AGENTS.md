# AGENTS.md — typewriter

Instructions for agents working on `packages/typewriter`.

## What this package is

`typewriter` ("framework for crypto apps") is a prescriptive framework, not a generic engine that adapts to arbitrary contracts. It prescribes the shape of the contracts that use it — execution surface, storage layout conventions, event conventions — so that the runtime, decode layer, and tooling above it can be sharp and opinionated rather than defensive. Conformance is the API.

## Motivations

Building a production crypto app today means assembling a stack of disconnected systems — sequencing, account abstraction, settlement, layer 2 scaling, indexing — and carrying the hard-won knowledge of how they fit together. The result is fragmented even when it works, and the assembly is the reason apps ship with a less ambitious product than they originally planned.

typewriter is a full-stack framework that unifies that stack behind a single opinionated runtime — one that abstracts transaction submission the way React's runtime abstracted DOM rendering. Developers describe their app's state and the mutations that change it; the runtime owns ordering, confirmation, and settlement. Applications are the fundamental unit to optimize for: they define the requirements that everything below them — sequencing, accounts, confirmations, settlement — has to answer to.

## Beliefs

What we believe that makes typewriter different.

- **Compete on technical merit, not ideology.** The next generation of crypto apps will be defined by what works, not by adherence to existing camps.
- **Blockchains are the database, not the backend.** They occupy the persistence layer of the stack; everything else — sequencing, validation, application logic — lives above them.
- **Write logic once.** Contract and backend shouldn't duplicate the same logic in two places. Pick one home for each piece and let the other defer to it.
- **A handful of apps, not contracts for everyone.** Only a few crypto apps of real consequence will be built. typewriter optimizes for taking the best teams from idea to production as fast as possible — and for letting those apps show what a chain can do beyond "EVM, but faster" — rather than putting contract authorship in everyone's hands.
- **Focus compounds.** Outcomes follow a power law, so doubling down on the core idea beats spreading thin across adjacent ones. Every new surface dilutes the one that matters.
- **Pragmatism over assembly.** Everything typewriter enables is technically possible today by stitching together L2 rollups, account abstraction providers, and other middleware. typewriter delivers the same results without the cruft.

## Feedback loops

High-level signals for whether typewriter is on the right track. None are precisely measurable; they're the lenses to evaluate work through.

- **AI legibility.** Can an agent read this codebase and understand the motivations and decision-making behind it well enough to make good calls? If an agent has to guess at intent, the docs or the code are failing.
- **Focus.** Are the ideas distilled to their simplest possible form? Every added concept dilutes the surface; the bar for introducing one should be high.
- **Developer experience.** Deployment, environment setup, and modularity should feel simple and composable — small pieces that snap together, with the developer ultimately in control.
- **Performance.** Transaction latency and gas costs. The ceiling typewriter raises is partly a performance ceiling — slow or expensive paths cap what apps can be.

## Tests

`bunfig.toml` preloads `test/setup.ts`, which compiles the test contracts (`test/contracts/`), boots anvil via `prool` on a free random port, creates an isolated Postgres database per test from `DATABASE_URL`, and registers a global `beforeEach` that snapshot-reverts chain state between tests. Each test deploys its own contracts via `deployCounter` / `deployHarness` from `test/utils.ts` — there's no shared deployment to remember.

Run typewriter tests from `packages/typewriter` (`bun test`) or through the workspace script
(`bun run --filter typewriter test`). Do not run `bun test packages/typewriter` from the repo
root: that does not load `packages/typewriter/bunfig.toml`, so the preload hooks can
tear down Anvil/Postgres before later files run.

If broad test runs fail during setup, run `DATABASE_URL=postgres://postgres@localhost:5432/postgres bun test packages/typewriter/test/setup.test.ts` first to isolate Anvil/Postgres environment failures before debugging app logic.

## Roadmap

The frame: every change is purpose-built for making it easier to build apps with typewriter, or for making the apps built better. Apps come first; the framework follows them. The goal is to keep the consuming apps (`apps/order-book`, and the minimal `apps/token`) demo-grade while extracting reusable framework seams into typewriter.

### Next Step

Add more testing around Solidity parsing. The current implementation can import an existing Solidity entrypoint, run Forge, read artifacts/ASTs, and derive runtime metadata that used to be copied into TypeScript by hand. Before expanding the surface, tighten coverage around the supported contract shape and the failure modes developers will actually hit: invalid/missing `Mutation` enums, unsupported `dispatch`/`abi.decode` forms, nested struct params, signature struct extraction, storage-layout flattening, multiple candidate contracts, and developer-facing parser errors.

The larger follow-on items are server-managed deployment and Solidity codegen. Deployment should bind runtime startup to a persisted artifact/deployed-bytecode match instead of copied addresses. Codegen should remove the remaining hand-authored protocol boilerplate (`execute`, `enqueue`, `forceExecute`, dispatch, scheduler access control, force-inclusion queue/events) once the parsed contract conventions are proven by tests.

### Lanes

The work catalog. Non-sequenced — items in different lanes can run in parallel.

**1. Missing implementation.** Things that are part of the framework but aren't there yet.
- Reorg recovery beyond detection/fatal runtime failure
- Signed receipts / client-side equivocation proving
- Signature validation at execute time. EIP-712, native signature verification, and the wire-format codec are in place; the unresolved question is whether typewriter should validate signatures during `execute()` admission, instead of waiting until batch-submission time or on-chain execution.

**2. Production readiness.** Hardening for running real apps.
- Shutdown testing (deterministic drain)
- Scheduler KMS / better account system

**3. Developer experience.** Usability — make the framework feel small and composable.
- State sync (granular slot subscriptions; falls out of revm)
- More Solidity parsing test coverage and clearer convention-focused parser errors
- AST parsing for additional conformance/runtime values, including EIP-712 domain extraction
- Zod schemas for HTTP endpoint enforcement
- Automatic deployment management (no copying addresses into env vars)
- CLI scaffolding (`typewriter dev` with anvil + fixture contract)

### Initiatives

Multi-week projects that span lanes. Each has its own internal sequence.

**Account/signature boundary.** typewriter requires EIP-712 and supports three signature algorithms: P-256, WebAuthn-P256, and secp256k1. It does not prescribe account/key/nonce state. Users implement the account registry, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions in their app and contract.

**Server-managed deployment.** Runtime startup should eventually deploy or load the matching compiled artifact, persist deployment metadata, and verify deployed bytecode against the artifact before starting. This removes copied contract addresses from app env/config and prevents the server from running against stale generated artifacts or stale deployed bytecode.

**Solidity codegen.** Once Solidity parsing is well-tested, generate the typewriter-owned protocol shell instead of requiring apps to hand-author it. The first target is removing dispatch boilerplate: derive mutation tags and params from the parsed contract, generate the `dispatch` branch/`abi.decode` wiring, and keep app contracts focused on business logic. Larger codegen can then absorb `execute`, `enqueue`, `forceExecute`, scheduler access control, force-inclusion queue/events, and server-consumable artifacts.

**Scheduler key management.** Today `TypewriterConfig.account: PrivateKeyAccount` is in-process key material — fine for dev, a footgun for production. Three pieces share the same seam (the framework's signing identity): KMS / remote signer support, nonce recovery on conflict, and user-shaped signing on-contract (scheduler key in the same registry as user keys, with rotation/expiry/scopes).

**Equivocation receipts.** Unbuilt. The goal is settled — signed accepted receipts let users prove the scheduler accepted one mutation and settled another — but receipt shape/hashing, observability, proof scope, and signing identity are open (see Open decisions and `PLAN_equivocation.md`).

**Runtime failure policy.** Today submit/watch failures can still kill the runtime fiber after mutations have already been accepted. Define the lifecycle for accepted-but-not-submitted batches: retry forever, mark failed, dead-letter, or emit a recoverable status. Clients need a clear way to observe the outcome.

### Open decisions

Forks that gate sequencing. Listed so they don't get rediscovered every session.

- **Execute-time signature validation.** Should typewriter validate signatures during `execute()` admission, or leave validation to on-chain execution? Execute-time validation gives faster rejection and avoids queueing obviously invalid mutations, but it requires a state-side key lookup seam or a user-supplied validator. Batch/settlement-time validation keeps the framework boundary smaller and user-owned, but invalid signatures can enter the queue and only fail later.
- **Equivocation receipt observability.** Should settled mutation hashes be exposed through events, storage commitments, decoded calldata, or app-owned HTTP routes? This determines how clients/watchers compare accepted receipts to chain reality.
- **Equivocation proof scope.** Should typewriter stop at client-side/social proof helpers, or add optional onchain proof storage/events for receipt-vs-settlement conflicts?
- **Server receipt identity.** What key signs accepted receipts, how is that key advertised, rotated, and scoped to an app/deployment?
- **Onchain-only recovery.** Can typewriter recover entirely from chain data plus contract storage/account roots, treating the database as a rebuildable cache rather than a required recovery source?
- **revm block context.** Before broadcast, what `block.number` and `block.timestamp` does revm execute against: latest+1, wall-clock values, or scheduler-controlled block context?
- **revm divergence detection.** Can revm detect onchain/offchain divergence by comparing account roots, or does typewriter need another settlement/reconciliation signal?

## Working in this package

- **Don't add speculative surface.** Every exported type, function, and config field must have a real call site that needs it. If nothing in the order-book app (or another consumer) calls it, delete it. We'll build the surface up one extraction at a time.
- **Don't write README/doc sections ahead of code.** Document features after they work, not before.
- **The README is evidence, not argument.** It should describe what typewriter is and does so readers can draw their own conclusions about why it's impactful. Don't editorialize or make the case for the framework in it.
- **Don't leak order-book vocabulary.** No mention of `instrument`, `order`, `fill`, `tick`, etc. in typewriter code. If a concept feels generic but the only example is order-book, it probably isn't generic yet.
- **Prefer ox over viem.** See root `AGENTS.md`.
