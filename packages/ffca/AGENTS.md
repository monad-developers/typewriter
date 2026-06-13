# AGENTS.md — ffca

Instructions for agents working on `packages/ffca`.

## What this package is

`ffca` ("framework for crypto apps") is a prescriptive framework, not a generic engine that adapts to arbitrary contracts. It prescribes the shape of the contracts that use it — execution surface, storage layout conventions, event conventions — so that the runtime, decode layer, and tooling above it can be sharp and opinionated rather than defensive. Conformance is the API.

## Motivations

Building a production crypto app today means assembling a stack of disconnected systems — sequencing, account abstraction, settlement, layer 2 scaling, indexing — and carrying the hard-won knowledge of how they fit together. The result is fragmented even when it works, and the assembly is the reason apps ship with a less ambitious product than they originally planned.

ffca is a full-stack framework that unifies that stack behind a single opinionated runtime — one that abstracts transaction submission the way React's runtime abstracted DOM rendering. Developers describe their app's state and the mutations that change it; the runtime owns ordering, confirmation, and settlement. Applications are the fundamental unit to optimize for: they define the requirements that everything below them — sequencing, accounts, confirmations, settlement — has to answer to.

## Beliefs

What we believe that makes ffca different.

- **Compete on technical merit, not ideology.** The next generation of crypto apps will be defined by what works, not by adherence to existing camps.
- **Blockchains are the database, not the backend.** They occupy the persistence layer of the stack; everything else — sequencing, validation, application logic — lives above them.
- **Write logic once.** Contract and backend shouldn't duplicate the same logic in two places. Pick one home for each piece and let the other defer to it.
- **A handful of apps, not contracts for everyone.** Only a few crypto apps of real consequence will be built. ffca optimizes for taking the best teams from idea to production as fast as possible — and for letting those apps show what a chain can do beyond "EVM, but faster" — rather than putting contract authorship in everyone's hands.
- **Focus compounds.** Outcomes follow a power law, so doubling down on the core idea beats spreading thin across adjacent ones. Every new surface dilutes the one that matters.
- **Pragmatism over assembly.** Everything ffca enables is technically possible today by stitching together L2 rollups, account abstraction providers, and other middleware. ffca delivers the same results without the cruft.

## Feedback loops

High-level signals for whether ffca is on the right track. None are precisely measurable; they're the lenses to evaluate work through.

- **AI legibility.** Can an agent read this codebase and understand the motivations and decision-making behind it well enough to make good calls? If an agent has to guess at intent, the docs or the code are failing.
- **Focus.** Are the ideas distilled to their simplest possible form? Every added concept dilutes the surface; the bar for introducing one should be high.
- **Developer experience.** Deployment, environment setup, and modularity should feel simple and composable — small pieces that snap together, with the developer ultimately in control.
- **Performance.** Transaction latency and gas costs. The ceiling ffca raises is partly a performance ceiling — slow or expensive paths cap what apps can be.

## Status

Implemented and tested end-to-end against anvil. The runtime drains a mutation queue, orders each batch (`config.sequencing.batchOrder` in batch mode, FIFO otherwise), executes each mutation in revm from submitted params/signature only, and rejects on revert. Accepted mutations persist to ffca-owned generated mutation tables, raw slot diffs to `slot_writes`, and mapping/dynamic-path hints to `known_paths` — there is no `.apply()`, app-owned persistence hook, `state.schema`, `state.load`, `resolve`, or app-level mutation resolution. Submit re-simulates the final calldata in revm, takes the gas limit and access list from that simulation (no RPC `createAccessList`/`estimateGas`), signs, and broadcasts via `eth_sendRawTransactionSync`; a watch loop then advances included mutations through safe/finalized. Mutation signing requires EIP-712, with native verification for P-256, WebAuthn-P256, and secp256k1 — ffca owns those primitives but leaves account/key/nonce authorization to the app. Calldata is `(uint8[] tags, bytes[] mutationData, bytes[] signatures)[]`, each `signatures[i]` ABI-encoded against `FFCAConfig.signature.params`. Events fan out via `on(event, cb) → unsubscribe` for mutation/batch/block. Force inclusion (`enqueue` / `forceExecute` / scheduler-assisted settlement) is implemented; its production-policy forks live under Open decisions.

Restart is partial. `createFFCA()`/`migrate()` compute a per-deployment schema, materialize generated tables, hydrate revm from the latest slot write per slot, resume the next mutation id from the tables, and read the execution index from the chain. But existing schemas drop unsettled mutations and their slot writes on startup: queued, accepted-but-unsubmitted, and in-flight batches are not recovered, and schema compatibility is not yet tracked before reuse.

## Tests

`bunfig.toml` preloads `test/setup.ts`, which compiles the test contracts (`test/contracts/`), boots anvil via `prool` on a free random port, creates an isolated Postgres database per test from `DATABASE_URL`, and registers a global `beforeEach` that snapshot-reverts chain state between tests. Each test deploys its own contracts via `deployCounter` / `deployHarness` from `test/utils.ts` — there's no shared deployment to remember.

Run ffca tests from `packages/ffca` (`bun test`) or through the workspace script
(`bun run --filter ffca test`). Do not run `bun test packages/ffca` from the repo
root: that does not load `packages/ffca/bunfig.toml`, so the preload hooks can
tear down Anvil/Postgres before later files run.

If broad test runs fail during setup, run `DATABASE_URL=postgres://postgres@localhost:5432/postgres bun test packages/ffca/test/setup.test.ts` first to isolate Anvil/Postgres environment failures before debugging app logic.

## Roadmap

The frame: every change is purpose-built for making it easier to build apps with ffca, or for making the apps built better. Apps come first; the framework follows them. The goal is to keep the consuming apps (`apps/order-book`, and the minimal `apps/token`) demo-grade while extracting reusable framework seams into ffca.

### Lanes

The work catalog. Non-sequenced — items in different lanes can run in parallel.

**1. Missing implementation.** Things that are part of the framework but aren't there yet.
- Reorg recovery beyond detection/fatal runtime failure
- Signed receipts / client-side equivocation proving
- Signature validation at execute time. EIP-712, native signature verification, and the wire-format codec are in place; the unresolved question is whether ffca should validate signatures during `execute()` admission, instead of waiting until batch-submission time or on-chain execution.

**2. Production readiness.** Hardening for running real apps.
- Shutdown testing (deterministic drain)
- Nonce recovery on conflict
- Scheduler KMS / better account system

**3. Developer experience.** Usability — make the framework feel small and composable.
- State sync (granular slot subscriptions; falls out of revm)
- Type inference from contracts (extract mutation and state types from Solidity)
- AST parsing for conformance + runtime values (validate contract shape, extract EIP-712 domain automatically)
- Zod schemas for HTTP endpoint enforcement
- Automatic deployment management (no copying addresses into env vars)
- CLI scaffolding (`ffca dev` with anvil + fixture contract)

**4. Documentation.** Someone should be able to read the docs and form a clear picture of how ffca works. Today it's almost empty.
- Architecture diagram (mutation → batch → submit → watch + the four loops)
- "What ffca prescribes vs. what the app owns" matrix
- Migration / port playbook (evergreen output of the order-book port)

### Initiatives

Multi-week projects that span lanes. Each has its own internal sequence.

**Account/signature boundary.** ffca requires EIP-712 and supports three signature algorithms: P-256, WebAuthn-P256, and secp256k1. It does not prescribe account/key/nonce state. Users implement the account registry, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions in their app and contract.

**AST + storage-layout codegen.** A lot of what the backend currently hand-authors could be read from the contract instead — batch tuple shape, mutation tag enum, per-mutation param ABI, EIP-712 domain, state shape, event ABI, error selectors. Mechanics are `forge build`'s AST and `forge inspect storageLayout`. TS can't read those at type-check time, so typed access requires codegen as a derived artifact. Runtime behavior (encoding, tag mapping, layout reads) can come straight from the contract without codegen.

**Scheduler key management.** Today `FFCAConfig.account: PrivateKeyAccount` is in-process key material — fine for dev, a footgun for production. Three pieces share the same seam (the framework's signing identity): KMS / remote signer support, nonce recovery on conflict, and user-shaped signing on-contract (scheduler key in the same registry as user keys, with rotation/expiry/scopes).

**Equivocation receipts.** Unbuilt. The goal is settled — signed accepted receipts let users prove the scheduler accepted one mutation and settled another — but receipt shape/hashing, observability, proof scope, and signing identity are open (see Open decisions and `PLAN_equivocation.md`).

**Runtime failure policy.** Today submit/watch failures can still kill the runtime fiber after mutations have already been accepted. Define the lifecycle for accepted-but-not-submitted batches: retry forever, mark failed, dead-letter, or emit a recoverable status. Clients need a clear way to observe the outcome.

**Persistence/restart policy.** ffca owns generated mutation persistence, lifecycle updates, raw slot diffs, and known paths. Startup can hydrate revm from persisted slots, but the runtime still needs a clear policy for queued, accepted-but-unsubmitted, and in-flight batches; how to surface or retry submit-fiber failures after optimistic acceptance; whether and how recovered state is compared against onchain state; and how generated schema metadata is tracked and compared before schema reuse.

### Open decisions

Forks that gate sequencing. Listed so they don't get rediscovered every session.

- **Execute-time signature validation.** Should ffca validate signatures during `execute()` admission, or leave validation to on-chain execution? Execute-time validation gives faster rejection and avoids queueing obviously invalid mutations, but it requires a state-side key lookup seam or a user-supplied validator. Batch/settlement-time validation keeps the framework boundary smaller and user-owned, but invalid signatures can enter the queue and only fail later.
- **Persistence/read-model shape.** How should apps serve decoded state/read-model queries: direct `ffca.state` storage reads driven by app-owned indexes, storage-diff-derived projections, event/index-based projections, or a hybrid? Generic mapping enumeration is not viable; mapping keys must come from calldata/events/indexes/path declarations.
- **Offchain derived indexes.** `known_paths` (mapping-key sets) is the first and most degenerate instance of a recurring need: derived indexes over offchain state — ordered/live subsets, secondary lookups, aggregates — consumed by read/API handlers and, eventually, execution-witness tooling. Two sub-problems hide inside it: *key discovery* (slot-irreversible; must come from calldata/events/declarations/witnesses) vs *projection* (ordering/aggregation/filtering over known keys). Index lifecycle must track revm's speculative → confirmed → reverted rollback, coupling it to the reorg and persistence/restart decisions. Hold any projection/reducer engine until 2+ concrete indexes demand it. Sharpens "Persistence/read-model shape," which frames only the read side.
- **Execution witness shape.** App-level mutation resolutions have been removed; the open question is what lower-level execution witness, if any, should accompany settled transactions in protocol or out of protocol.
- **Force-inclusion queue enforcement.** Production contracts should make it hard for the scheduler to leave old force-inclusion entries pending forever. Current contracts carry explicit queue indexes and do not enforce mandatory draining of all entries older than `FORCE_INCLUSION_DELAY`. Stronger FIFO/draining guarantees likely want a queue-head invariant plus an immutable age threshold.
- **Force-inclusion delay semantics.** Should scheduler-assisted execution of queued mutations inside `execute` obey the same delay as public `forceExecute`, or may the scheduler include queued mutations immediately?
- **Invalid force-inclusion queue heads.** If an enqueued mutation becomes invalid or expired, does it block the queue, get skipped/marked failed, or should enqueue validate/reserve enough state to prevent invalid heads?
- **Force-inclusion observability.** Which events/views are required for clients and watchers to discover queued mutations, see whether the scheduler included them, and detect old pending entries?
- **Equivocation receipt observability.** Should settled mutation hashes be exposed through events, storage commitments, decoded calldata, or app-owned HTTP routes? This determines how clients/watchers compare accepted receipts to chain reality.
- **Equivocation proof scope.** Should ffca stop at client-side/social proof helpers, or add optional onchain proof storage/events for receipt-vs-settlement conflicts?
- **Server receipt identity.** What key signs accepted receipts, how is that key advertised, rotated, and scoped to an app/deployment?
- **revm initial state source.** Today runtime pulls bytecode from chain and seeds storage from persisted slot diffs. Long term, should runtime hydrate deployed storage from chain at boot or replay the deployment transaction locally, treating the database as a rebuildable cache rather than the source of truth?
- **Onchain-only recovery.** Can ffca recover entirely from chain data plus contract storage/account roots, treating the database as a rebuildable cache rather than a required recovery source?
- **revm block context.** Before broadcast, what `block.number` and `block.timestamp` does revm execute against: latest+1, wall-clock values, or scheduler-controlled block context?
- **revm divergence detection.** Can revm detect onchain/offchain divergence by comparing account roots, or does ffca need another settlement/reconciliation signal?
- **Accepted-but-not-submitted batches.** If submission fails after optimistic acceptance, are batches retried indefinitely, marked failed, dead-lettered for manual intervention, or surfaced through a distinct lifecycle state?
- **Restart semantics.** Which runtime states survive process restart: queued mutations, accepted-but-unsubmitted batches, proposed-but-unverified batches, local nonce cache, and deployment locks?

## Working in this package

- **Don't add speculative surface.** Every exported type, function, and config field must have a real call site that needs it. If nothing in the order-book app (or another consumer) calls it, delete it. We'll build the surface up one extraction at a time.
- **Don't write README/doc sections ahead of code.** Document features after they work, not before.
- **The README is evidence, not argument.** It should describe what ffca is and does so readers can draw their own conclusions about why it's impactful. Don't editorialize or make the case for the framework in it.
- **Don't leak order-book vocabulary.** No mention of `instrument`, `order`, `fill`, `tick`, etc. in ffca code. If a concept feels generic but the only example is order-book, it probably isn't generic yet.
- **Prefer ox over viem.** See root `AGENTS.md`.
