# ffca roadmap

Working plan for getting ffca to production-ready by shipping two real apps on it. This is sequenced, not exhaustive — it points at the *next* set of decisions, not every concept ffca will eventually need.

The goal is concrete: **two production apps running on ffca.** App #1 is the order-book demo (port the existing backend). App #2 is undecided — the choice will be informed by what we learn from #1.

## Where ffca is today

~720 lines across config, types, runtime, eip712, encoding. End-to-end against anvil:

- Mutation lifecycle types (pending → accepted → rejected → proposed → ...).
- Bundle loop: drains queue, sorts by `config.sequence`, runs `resolve` then `apply` per mutation.
- Submit: simulate → access list → estimate → sign → broadcast → block lookup → AnchoredBundle. Single RPC. 8x retry.
- EIP-712 typed-data verification (state-independent half — shape, address validity, uint range).
- Bundle calldata encoding (`(uint8[] mutations, bytes[] mutationData, bytes[] signatures)[]`).
- Event fan-out via `on(event, cb) → unsubscribe`. Three streams: mutation, bundle, block.
- Test harness: anvil + prool, two contract fixtures (Counter, Harness), 26 tests including 5 e2e against a real chain.

## What's missing for production

Grouped by what they unblock. Earlier entries gate later entries.

### 1. Signature wire format alignment (port-blocker)

Order-book contract expects `Signature[]` structs: `(bytes32 account, uint64 keyId, bytes rawSignature)[]`. ffca encodes signatures as opaque `bytes[]`. **The backend cannot send a bundle the order-book contract will accept today.**

Fix: app-side wrapping. Backend wraps each signature into the struct shape and ABI-encodes it as `bytes` before calling `ffca.execute()`. ffca treats it opaquely. Account-system shaping is the app's concern by design.

Estimate: small backend-side change.

### 2. Watch loop (port-blocker)

`runtime.ts:401-406` is empty. Without it, bundles never advance past `proposed`. The backend's observability (HTTP `/api/blocks` etc.) needs `voted/finalized/verified` to mean something.

Fix: poll `publicClient.getBlock`, advance status by confirmation depth (configurable), persist transitions in-memory, emit `BlockEvent`s. Pattern at `apps/order-book-backend/src/runtime.ts:1098-1176`.

Estimate: medium. ~80 lines plus a depth config.

### 3. Order-book port

With #1 and #2 done, port the order-book backend to consume ffca for the runtime piece. Persistence, HTTP routes, and signature verification stay in the backend app — don't push them into ffca yet. The port itself surfaces what generalizes.

Estimate: large but bounded. The diff in the backend is mostly removing 1,000+ lines of runtime code and replacing with `createFFCA` + event subscribers.

### 4. Failure isolation

Today, if a mutation's `apply` throws *after* mutating state, the bundle continues with corrupted state. Tests caught the simple case (apply throws cleanly via guard), but multi-step partial mutations are unprotected.

Fix: `structuredClone` state per mutation, swap back on throw. Order-book accepts the perf hit ("Major perf pain point — needs a different model"). For two apps, take the perf hit; revisit when it becomes a problem.

Estimate: small to do, large to do well.

### 5. RPC robustness

Single RPC + 8x retry handles transients but not RPC-down. Two paths:
- (a) Multiplex across N RPCs with `raceFirstSuccess` (order-book pattern).
- (b) Health-check RPCs and failover.

For two apps, (a) is enough. Defer (b).

Estimate: medium.

### 6. Nonce recovery

Local nonce cache assumes ffca is the only writer for the scheduler key. Real production sees external resets (operator override, parallel deployment). Today's code never refetches.

Fix: on submit error matching nonce-shaped patterns, refetch from `eth_getTransactionCount(pending)` and retry. Per-provider error parsing required.

Estimate: small once the error-shape catalog is built.

### 7. App #2: what is it?

The decision that scopes everything else. Candidates dictate what generalizes:
- Another orderbook variant — minimal new ffca surface needed.
- A token / payments app — drives state-shape generalization.
- A game / social app — drives signing/account-model work.

Picking #2 should happen *during* the order-book port, not after. Watching the port surface its pain points narrows the choice.

## What I'm explicitly deferring

These are real concepts but don't gate the two-app goal:

- **Generics over `FFCAConfig`.** Improves DX (drops the `as any` casts, types `args` per mutation) but doesn't unblock anything functional. Land after the port if it hurts.
- **Persistence in ffca.** Apps own this until two apps share a schema shape.
- **KMS / HSM signers.** Footgun, but the env-var private key works for the demo apps. Address when there's real money.
- **Storage-layout codegen.** Multi-month. Worth it when there's a third app.
- **revm runtime.** Separate project. The motivation will be sharper after seeing the order-book port complete.
- **AST-derived encoding (mutation tags, bundle shape, etc.).** Hand-authored is fine for two apps.
- **State-aware sequencing callback.** Name-list sequencing is enough for the order-book; the backend's `cancel → limit → market` ordering is just a name list.
- **Stream-shaped event API.** Callbacks suffice for the port; SSE encoding is the app's job.

## Sequencing (what to do, in order)

1. **App-side signature struct wrapping** — unblocks calling the order-book contract.
2. **Watch loop in ffca** — `proposed → voted → finalized → verified`.
3. **Order-book port** — replace backend's runtime.ts with `createFFCA`. App keeps DB, HTTP, signatures, nonces.
4. **Decide app #2** — should be obvious by mid-port.
5. **Surface what hurt during the port; fix in ffca or app per the rule of "if two apps need it, it's framework."**
6. **Failure isolation (`structuredClone`).** Required to be honest about production correctness.
7. **RPC multiplexing.** Required to be honest about production reliability.
8. **Build app #2.** Validate the framework framing. If it feels good, generalize the patterns the second port reveals.

Steps 1-3 are well-scoped (two weeks?). 4 is a decision moment. 5-7 expand from "framework prototype" to "framework production." 8 is the proving ground.

## What we learn at each milestone

- **After step 3:** is ffca actually useful as a runtime? Did it reduce code, or just shuffle it? What did the port surface that's framework-shaped?
- **After step 5:** does the second app fit cleanly, or did we over-fit to the order-book? This is the moment we know whether the framework framing works.
- **After step 8:** is anyone else likely to use this? Or is the value really in being a sharp internal tool?

The honest framing: ffca is **a reusable runtime** that's *aspiring* to be a framework. The two-app test is what tells us which it actually is. Either is fine — useful runtimes ship.
