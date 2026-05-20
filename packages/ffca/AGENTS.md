# AGENTS.md — ffca

Instructions for agents working on `packages/ffca`.

## What this package is

`ffca` ("framework for crypto apps") is a framework, not a runtime that adapts to arbitrary contracts. It prescribes the shape of the contracts that use it — execution surface, storage layout conventions, event conventions — so that the runtime, decode layer, and tooling above it can be sharp and opinionated rather than defensive. Conformance is the API.

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

Core implementation now spans config, types, runtime, watch, persistence/migration, EIP-712, encoding, schema helpers, storage-layout-backed state reads, revm execution, and native signature verification. End-to-end against anvil. The runtime drains a mutation queue, sorts by `config.sequence` when supplied (FIFO otherwise), calls `resolve` with a revm-backed async `ffca.state` storage proxy, executes each resolved mutation in revm, rejects on revm revert, then calls `.apply()` only after revm accepts to project the EVM transition into today's decoded JS read model. Persistence still reads that decoded projection when fully configured (database, `state.schema`, `state.load`, and every mutation's `persistMutation`/`persistState`/`persistLifecycle` hooks), then submit still uses simulate → access list → estimate → sign → broadcast → block lookup. A watch loop polls latest blocks, detects reorgs, and advances proposed bundles through voted/finalized/verified confirmation states. EIP-712 is required for mutation signing, and native signature verification exists for P-256, WebAuthn-P256, and secp256k1. ffca owns those primitives, but leaves account/key/nonce authorization up to users to implement. Calldata is `(uint8[] tags, bytes[] mutationData, bytes[] signatures)[]` where each `signatures[i]` is the ABI-encoding of one structured signature against the app-supplied `FFCAConfig.signature.params`. Event fan-out via `on(event, cb) → unsubscribe` for mutation/bundle/block. Tests cover config, encoding, EIP-712, migration, signatures, watch behavior, runtime behavior, storage seeding, and e2e flows against a real chain.

Migration/redeploy status: `migrate()` computes the per-deployment schema name, creates and materializes the schema when empty, and has a narrow restart fast path for an existing schema. `createFFCA()` is async and, when persistence is configured, calls the required `state.load(tx)` hook before starting runtime loops so the in-memory state is hydrated from persisted state tables, and resumes the next mutation and bundle ids from the max ids across persisted mutation tables. The fast path only asserts the database has no mutation rows still in `accepted` status; it does not replay accepted mutations, revert offchain-only state updates, check which accepted mutations landed onchain, or compare recovered state to onchain state. If accepted mutations are present, startup fails loudly because generic recovery is not implemented. Schema compatibility is not tracked yet; the intended next step is to persist generated schema metadata and compare that on redeploy before reusing an existing schema.

## Tests

`bunfig.toml` preloads `test/setup.ts`, which compiles the test contracts (`test/contracts/`), boots anvil via `prool` on a free random port, creates an isolated Postgres database per test from `DATABASE_URL`, and registers a global `beforeEach` that snapshot-reverts chain state between tests. Each test deploys its own contracts via `deployCounter` / `deployHarness` from `test/utils.ts` — there's no shared deployment to remember.

Run ffca tests from `packages/ffca` (`bun test`) or through the workspace script
(`bun run --filter ffca test`). Do not run `bun test packages/ffca` from the repo
root: that does not load `packages/ffca/bunfig.toml`, so the preload hooks can
tear down Anvil/Postgres before later files run.

If broad test runs fail during setup, run `DATABASE_URL=postgres://postgres@localhost:5432/postgres bun test packages/ffca/test/setup.test.ts` first to isolate Anvil/Postgres environment failures before debugging app logic.

## Roadmap

The frame: every change is purpose-built for making it easier to build apps with ffca, or for making the apps built better. Apps come first; the framework follows them. The goal is to keep `apps/order-book` demo-grade while extracting reusable framework seams into ffca.

### Lanes

The work catalog. Non-sequenced — items in different lanes can run in parallel.

**1. Missing implementation.** Things that are part of the framework but aren't there yet.
- Reorg recovery beyond detection/fatal runtime failure
- Force inclusion
- Signed receipts / client-side equivocation proving
- Alternative sequencing beyond FIFO/name-list ordering
- Signature validation at execute time. EIP-712, native signature verification, and the wire-format codec are in place; the unresolved question is whether ffca should validate signatures during `execute()` admission, instead of waiting until bundle/apply time or on-chain execution.
- Backpressure on the mutation/submit queues
- Persistence/restart policy for accepted and in-flight mutations

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

**revm as the server execution engine.** The biggest single change. Replaces the TS reimplementation of contract logic with the actual EVM bytecode running locally — the contract becomes the acceptance spec instead of a thing to keep in sync by hand. Current status: `storageLayout` is required, revm is seeded from decoded app state encoded into raw slots, `ffca.state` reads asynchronously through a storage proxy, `resolve` reads from that proxy, and revm accepts/rejects mutations before `.apply()` runs. `.apply()` is now only a decoded read-model projection for persistence/API state; do not remove it until persistence has a revm-backed replacement. The next useful work is persistence shape: decoded slot writes and/or explicit storage reads with app-owned indexes. Generic mapping enumeration is not possible from storage alone; dynamic-array `.length` is useful and feasible. Long term, restart should rebuild from onchain/deployment state rather than trusting the database as revm's boot source.

**Account/signature boundary.** ffca requires EIP-712 and supports three signature algorithms: P-256, WebAuthn-P256, and secp256k1. It does not prescribe account/key/nonce state. Users implement the account registry, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions in their app and contract.

**AST + storage-layout codegen.** A lot of what the backend currently hand-authors could be read from the contract instead — bundle tuple shape, mutation tag enum, per-mutation param ABI, EIP-712 domain, state shape, event ABI, error selectors. Mechanics are `forge build`'s AST and `forge inspect storageLayout`. TS can't read those at type-check time, so typed access requires codegen as a derived artifact. Runtime behavior (encoding, tag mapping, layout reads) can come straight from the contract without codegen.

**Scheduler key management.** Today `FFCAConfig.account: PrivateKeyAccount` is in-process key material — fine for dev, a footgun for production. Three pieces share the same seam (the framework's signing identity): KMS / remote signer support, nonce recovery on conflict, and user-shaped signing on-contract (scheduler key in the same registry as user keys, with rotation/expiry/scopes).

**Force inclusion.** The high-level goal is settled: users need a censorship escape hatch that lets them put signed mutations onchain and eventually execute without scheduler cooperation. The remaining work is policy and observability: scheduler-assisted delay semantics, mandatory draining of old queue entries, invalid/expired queue-head behavior, and the events/views clients need for queue discovery and watcher support. See `PLAN_force_inclusion.md`.

**Equivocation receipts.** The high-level goal is settled: signed accepted receipts let users prove the scheduler accepted one mutation and settled another. The remaining work is receipt shape and hashing, settled-mutation-hash observability, client-side proof vs optional onchain proof, and server receipt signing identity. See `PLAN_equivocation.md`.

**Runtime failure policy.** Today submit/watch failures can still kill the runtime fiber after mutations have already been accepted. Define the lifecycle for accepted-but-not-submitted bundles: retry forever, mark failed, dead-letter, or emit a recoverable status. Clients need a clear way to observe the outcome.

**Persistence/restart policy.** Persistence hooks write accepted/lifecycle state, and migration now supports a narrow redeploy fast path only when there are no `accepted` persisted mutations. The runtime still needs a clear answer for process restart: what happens to queued, accepted-but-unsubmitted, and in-flight bundles; how to revert persisted state updates for mutations that never landed onchain; how to identify accepted mutations that did land onchain; how runtime state is hydrated; how recovered state is compared against onchain account roots; whether ffca owns a minimal mutation log or stays fully app-owned; and how generated schema metadata is tracked and compared before schema reuse.

### Open decisions

Forks that gate sequencing. Listed so they don't get rediscovered every session.

- **Execute-time signature validation.** Should ffca validate signatures during `execute()` admission, or leave validation to app-owned `resolve`/`apply` logic and on-chain execution? Execute-time validation gives faster rejection and avoids queueing obviously invalid mutations, but it requires a state-side key lookup seam or a user-supplied validator. Bundle/apply-time validation keeps the framework boundary smaller and user-owned, but invalid signatures can enter the queue and only fail later.
- **Persistence shape.** `.apply()` currently maintains decoded tables/read models after revm accepts a mutation. Removing `.apply()` is gated on replacing that projection. Options: decoded slot writes from revm plus a known-path registry, explicit `ffca.state` storage reads driven by app-owned indexes, or a hybrid. Generic mapping enumeration is not a viable plan; mapping keys must come from calldata/events/indexes/path declarations.
- **Resolution language.** Off-chain matching is settled. Open question: is the resolution itself written in TypeScript (today's order-book) or in Solidity (a view function the runtime calls)? Solidity-side resolutions remove the TS/Sol drift but are gas/perf-sensitive and harder to debug.
- **Force-inclusion queue enforcement.** Production contracts should make it hard for the scheduler to leave old force-inclusion entries pending forever. The current Counter fixture preserves ordered queue execution, but it does not enforce mandatory draining of all entries older than `FORCE_INCLUSION_DELAY`. That likely wants a stronger queue data structure plus an immutable age threshold.
- **Force-inclusion delay semantics.** Should scheduler-assisted execution of queued mutations inside `execute` obey the same delay as public `forceExecute`, or may the scheduler include queued mutations immediately?
- **Invalid force-inclusion queue heads.** If an enqueued mutation becomes invalid or expired, does it block the queue, get skipped/marked failed, or should enqueue validate/reserve enough state to prevent invalid heads?
- **Force-inclusion observability.** Which events/views are required for clients and watchers to discover queued mutations, see whether the scheduler included them, and detect old pending entries?
- **Equivocation receipt observability.** Should settled mutation hashes be exposed through events, storage commitments, decoded calldata, or app-owned HTTP routes? This determines how clients/watchers compare accepted receipts to chain reality.
- **Equivocation proof scope.** Should ffca stop at client-side/social proof helpers, or add optional onchain proof storage/events for receipt-vs-settlement conflicts?
- **Server receipt identity.** What key signs accepted receipts, how is that key advertised, rotated, and scoped to an app/deployment?
- **revm initial state source.** Today runtime pulls bytecode from chain and seeds storage from decoded `state.initial` / `state.load` through `config.storageLayout`. Long term, should runtime hydrate deployed storage from chain at boot or replay the deployment transaction locally? The desired direction is to remove `config.state.initial` for persisted runtimes and read/rebuild initial runtime state from onchain deployment state.
- **Onchain-only recovery.** Can ffca recover entirely from chain data plus contract storage/account roots, treating the database as a rebuildable cache rather than a required recovery source?
- **revm block context.** Before broadcast, what `block.number` and `block.timestamp` does revm execute against: latest+1, wall-clock values, or scheduler-controlled block context?
- **revm divergence detection.** Can revm detect onchain/offchain divergence by comparing account roots, or does ffca need another settlement/reconciliation signal?
- **Accepted-but-not-submitted bundles.** If submission fails after optimistic acceptance, are bundles retried indefinitely, marked failed, dead-lettered for manual intervention, or surfaced through a distinct lifecycle state?
- **Restart semantics.** Which runtime states survive process restart: queued mutations, accepted-but-unsubmitted bundles, proposed-but-unverified bundles, local nonce cache, and deployment locks?

## Working in this package

- **Don't add speculative surface.** Every exported type, function, and config field must have a real call site that needs it. If nothing in the order-book app (or another consumer) calls it, delete it. We'll build the surface up one extraction at a time.
- **Don't write README/doc sections ahead of code.** Document features after they work, not before.
- **The README is evidence, not argument.** It should describe what ffca is and does so readers can draw their own conclusions about why it's impactful. Don't editorialize or make the case for the framework in it.
- **Don't leak order-book vocabulary.** No mention of `instrument`, `order`, `fill`, `tick`, etc. in ffca code. If a concept feels generic but the only example is order-book, it probably isn't generic yet.
- **Prefer ox over viem.** See root `AGENTS.md`.
