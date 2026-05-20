# revm execution engine

Working notes for replacing ffca's TS-side state machine with revm. The
contract becomes the mutation acceptance spec: mutation calldata is executed by
revm against deployed bytecode, and revm storage is the runtime source of truth.

The current runtime is past shadow mode. `resolve` reads from a revm-backed
storage proxy, revm decides mutation acceptance, and `.apply()` is only the
decoded read-model projection that keeps today's persistence/API state in sync.
Deleting `.apply()` is intentionally not the next step; persistence and read
models need a revm-backed replacement first.

## What's already landed

Two packages now sit alongside `ffca`, and the runtime uses both.

- **`packages/evm`** — Rust sidecar wrapping `monad-revm`, driven by
  line-delimited JSON over stdio. Spawned per `createEVM`; Effect-native
  TS client serializes calls behind a semaphore. Implemented methods:
  `init`, `beginBundle`, `execute`, `simulate`, `commitBundles`,
  `revertBundle`, and `readStorage`. `execute` returns `{ success,
  gas_used, output, access_list, revert_data? }` and runs two passes
  internally so the returned access list matches `eth_createAccessList`
  for warmed-slot gas pricing. `readStorage` reads committed sidecar
  account storage slots for the storage proxy.
- **`packages/storage-layout`** — Solidity `storageLayout` JSON →
  slot/path machinery. `getStorageSlot`, `getStoragePath`,
  `decodeStorage`, `encodeStorage`, `encodeStorageState`,
  `createStorageProxy`, `parseStoragePath`, `formatStoragePath`. Supports
  value types, packed slots, structs, fixed and dynamic arrays, mappings
  with most key types, short and long `bytes`/`string` decode. Encoding
  can seed decoded app state into raw slots through a layout; runtime
  updates still come from revm execution. Mapping enumeration is not
  generally possible and remains intentionally unsupported.
- **`packages/ffca` runtime** — `FFCAConfig.storageLayout` is required.
  `createFFCA` pulls deployed bytecode from chain, encodes decoded
  `state.initial`/`state.load` into raw slots with `encodeStorageState`,
  seeds revm with that storage, exposes storage through `ffca.state`, and passes the
  storage proxy to `resolve({ state, ... })`. For each queued mutation,
  runtime resolves any offchain data, executes a single-mutation bundle in
  revm, rejects on revm revert, then calls `.apply()` only after revm
  success to update the decoded read model used by persistence and APIs.

## Direction

`ffca` adopts revm incrementally. revm now owns mutation acceptance and direct
storage reads. The remaining work is not more shadow validation; it is deciding
how persistence/read models are derived from revm state so `.apply()` can be
removed without losing app-queryable state.

## Beliefs that shape the design

- **No magic.** `packages/evm` is a wrapper, not a framework. The
  protocol is "EVM operations over JSON." Anything app-shaped (bundles,
  mutations, accounts) lives one layer up in `ffca`.
- **The contract is the spec.** Once revm is canonical, there is no
  second implementation of mutation logic. Solidity is the only place
  application logic lives.
- **Persistence becomes derived.** Today apps own `persistMutation` /
  `persistState` and read from the JS state object. Post-swap, apps
  read from revm via decoded slot writes — `storage-layout` projects
  raw `(slot, value)` writes back to typed paths the app consumes.
  Persistence is a projection of revm's state, not a parallel ledger.
  No view-function read path: revm doesn't expose `call`; everything
  reads through slot decoding.
- **Failure isolation as reorg.** Per-mutation revert and bundle revert
  are the same primitive — a journal checkpoint that may or may not be
  committed. Same primitive serves chain reorg recovery later.

## Adoption sequence

Each step lands as its own change. The TS state machine stays working
through step 5 — every step preserves end-to-end behavior.

### Step 1 — Wire revm into `createFFCA`

Status: landed, with a different shape than the original shadow-mode sketch.

- `createFFCA` spawns one sidecar at startup (`createEVM`) and inits it
  with deployed bytecode from `eth_getCode`.
- Initial revm storage is encoded from decoded app state via the required
  `config.storageLayout`. The runtime does not hydrate storage from chain yet.
- `ffca.state` is an async storage proxy backed by sidecar `readStorage`.
- `resolve({ state, ... })` receives that storage proxy, not the mutable JS
  decoded state object.

No mismatch log exists today because revm was promoted directly to the hot path.

### Step 2 — Promote revm to canonical for failure isolation

Status: mostly landed for mutation acceptance. The old per-mutation
`structuredClone(state)` rollback path is gone. State still flows through TS
`.apply()` only after revm success; if `.apply()` throws, the mutation is
rejected and revm's failed `execute` did not commit its diff.

- `structuredClone(state)` per mutation has been removed.
- The bundle Effect's outer `beginBundle` brackets all mutations in the bundle.
  If every queued mutation is rejected, runtime calls `revertBundle` to drop the
  open journal; success later calls `commitBundles` after broadcast.

The remaining checkpoint work is about bundle-level lifecycle cleanup and future
reorg/recovery semantics, not TS failure isolation.

### Step 3 — Promote revm to canonical for access list + gas

Drops `publicClient.createAccessList`, `publicClient.estimateGas`, and
`publicClient.simulateContract` from the submit fiber
(`runtime.ts:572-603`). revm's `simulate` against the final bundle
calldata produces both.

- Sidecar `simulate` already returns `access_list` and `gas_used`; the
  evm test suite confirms parity with `eth_createAccessList` for an
  ERC-20 transfer (`packages/evm/src/index.test.ts:374-400`).
- Add a small overhead to revm's `gas_used` for the wrapping execute
  function's overhead and broadcast variance. (Today's code adds 1% to
  `estimateGas`'s output; same heuristic applies.)
- Keep `sendRawTransactionSync` and the watch loop — those run against
  real chain.

This is what PR #13 was after. Now it sits on top of validated
canonical state instead of bolted-on simulation.

### Step 4 — Route mutation execution through revm

Status: landed for acceptance. `resolve` callbacks are still invoked because
some mutations compute resolution calldata offchain, but the source of truth for
whether a mutation succeeded is revm's `execute` result. The accepted/rejected
decision in the bundle Effect is "did revm's execute succeed?" instead of "did
TS apply throw?"

- Mutation calldata is ABI-encoded against ffca's conventional
  `execute(Bundle[], uint256[])` shape and sent to revm as a single-mutation
  bundle.
- `MutationEvent.resolution` is still populated from TS `resolve`; revm output
  decoding for Solidity-authored resolutions is future work.
- Revm revert data is decoded through viem ABI errors where possible.
- TS `.apply()` is still called on success, to keep decoded app state in sync
  for `ffca.state`, persistence hooks, and app APIs. Removing it is gated by
  Step 5.
- Bundle calldata format (`encodeBundleArg`) stays as-is — revm sees it
  as opaque bytes against the contract's `execute` function. A TS
  encoding bug surfaces as a revm revert.

Determinism still matters: revm and chain must agree on block context, spec,
immutables, and any Monad-specific semantics before revm-derived gas/access-list
data can replace RPC simulation.

### Step 5 — Source persistence callbacks from revm

This is the next important design/implementation step. It replaces the JS-state
read path inside `persistMutation` / `persistState` and defines what app query
models are derived from after `.apply()` is removed.

Two cases:

1. **Hooks that already read from `args` only** (the common case for
   `persistMutation`): unaffected. `args` still flows through
   unchanged.
2. **Hooks that read from `state` to compute persisted rows**
   (typically `persistState`): switch to one of the revm-backed seams below.
   The preferred long-term seam is decoded slot writes: `execute`'s response
   gains a `slot_writes` field listing `{ slot, prev_value, new_value }` per
   touched slot, and `storage-layout` projects writes back to typed paths with
   help from a known-path registry. A smaller interim seam is app-owned indexes
   plus explicit storage-proxy reads for the paths each persistence hook needs.

Generic mapping enumeration is not a goal and cannot be solved from storage
alone. Apps that need "all known X" must provide an index, derive keys from
calldata/events, or consume decoded writes with a known-path registry. Dynamic
array `.length` is a practical storage-proxy prerequisite because the length is
stored in the array root slot and is needed for generic array reads.

`persistLifecycle` is unaffected — it operates on bundle/block metadata
and doesn't read state.

### Step 6 — Delete the TS state machine

Once persistence is sourced from revm, the JS state object has no
remaining consumers other than app-owned read models. `ffca.state` is a
thin facade over `storage-layout` — apps declare paths they
want exposed, the runtime reads through `readStorage` + `decodeStorage`.

- Delete or repurpose `config.state.initial`, `config.state.load`,
  `config.state.schema` once restart/hydration no longer depends on decoded DB
  state as the seed.
- Delete `FFCAMutationConfig.apply` only after Step 5. Keep `.resolve` for TS
  offchain matching unless/until resolution moves into Solidity or another
  explicit execution language.
- Delete `structuredClone`, `resolveMutation`, `applyMutation`,
  `verifyResolution` from `runtime.ts`.
- `FFCAConfig.state` either survives as `state.hydrate(rpc)` returning
  bytecode + storage for sidecar init, or disappears entirely if the
  runtime can derive that from `config.address` alone.

After step 6, `runtime.ts` has no JS mutation projection and no decoded state as
an authority. Bundle ordering, queueing, fan-out, submit, and watch stay in TS.
revm owns state and execution; persistence/read models are derived from revm.

## RPC budget after the swap

The submit fiber's RPC surface collapses:

- **Gone:** `simulateContract`, `createAccessList`, `estimateGas`
  (replaced by sidecar `simulate`), `getTransactionCount` (replaced
  by revm's nonce), `getBlock(blockHash)` after submit (block number /
  hash / timestamp come from `sendRawTransactionSync`'s receipt).
- **Gone from the watch loop:** chain-state reconciliation back into
  revm. revm trusts itself — the scheduler is the only writer; chain
  confirmation that disagrees is a bug, not a recoverable state.
- **Current boot path:** `eth_getCode` for `config.address`, plus raw storage
  generated from decoded `config.state.initial` / `state.load` through
  `config.storageLayout`.
- **Future boot path:** `eth_getCode` / `eth_getStorageAt` for `config.address`
  and declared dependencies, or local deployment replay. Replaces decoded DB
  state as the source for revm initialization.
- **Hot path:** `sendRawTransactionSync` for broadcast; watch loop's
  `eth_getBlockByNumber` polling for confirmation depth. That's it.

## What we still need to build

The minimum that has to exist for persistence to move off `.apply()` and for
revm-derived gas/access-list data to replace RPC simulation.

### Sidecar (`packages/evm`)

What's there: `init`, `beginBundle`, `execute`, `simulate`,
`commitBundles`, `revertBundle`, `readStorage`, plus access-list discovery.
Gaps:

1. **`setBlockContext({ number, timestamp, basefee?, … })`.** Today
   block context is set once via `init`. Step 4 needs to advance it
   per bundle (or per `execute`) so revm's `block.number` /
   `block.timestamp` match what the scheduler will broadcast against.
   Open decision in the package roadmap ("revm block context") gates
   the exact semantics. Sidecar surface is small either way.
2. **Slot writes (and logs) in `execute` output.** Today `execute`
   returns `{ success, gas_used, output, access_list, revert_data? }`.
   Add `slot_writes: [{ address, slot, prev_value, new_value }]` —
   this is what step 5 consumes through `storage-layout` to produce
   the typed values `persistState` writes. Add `logs: [{ address,
   topics, data }]` alongside for event-driven persistence patterns
   and downstream state-sync.
3. **External account hydration after `init`.** Today every account
   has to be passed in `init.accounts`. For dependencies discovered
   lazily (an ERC-20 referenced via a constructor arg the scheduler
   doesn't know about), the sidecar needs `setAccount({ address,
   code, storage })` post-`init`. Defer until a real case forces it;
   eager hydration covers v1.

Deliberately not on this list: `call` (view-function read). Reading
state happens through slot decoding, not through view functions —
`ffca.state` and persistence both read `slot_writes` from `execute`
and `readStorage` for ambient reads.

### Storage-layout (`packages/storage-layout`)

What's there: `getStorageSlot`, `decodeStorage`, `encodeStorage`,
`encodeStorageState`, and `createStorageProxy` for value types including packed
slots, structs, fixed/dynamic arrays, mappings with most key types, short and
long bytes/string. `getStoragePath` reverse lookup exists for non-mapping paths.

Gaps that block step 5. See `packages/storage-layout/REVIEW_NOTES.md`
for the full inventory; the ones that gate revm canonical persistence:

1. **`matchStorageWrites(layout, writes, knownPaths)`.** Per
   `REVIEW_NOTES.md` finding 5 / simplification idea 2: the current
   `getStoragePath(layout, slots)` throws if any mapping exists in
   the layout, even when the changed slot is unrelated. Mappings
   need a known-path registry — without one, slot writes against
   mapping entries can't be projected back to typed paths. **This is
   now a hard prerequisite for step 5**, not a contingent one:
   without `call`, slot decoding is the only read path, and slot
   decoding doesn't work for mappings without the registry. The
   framework-side shape of the registry is the open decision below
   ("How do mutations declare touched paths?").
2. **Storage proxy dynamic-array `.length`.** The runtime can already read
   concrete array element paths, but generic array consumers need `.length`.
   Unlike mappings, this is feasible because the length lives at the array root
   slot.
3. **Dynamic-array encoding with a stale-slot policy.** Per finding
   2 and the in-code TODO at `src/index.ts:198-205`: shrinking arrays
   leave old element slots behind. Decoding works; encoding is
   intentionally unimplemented. Not needed for step 5 — encoding is
   only relevant if TS writes back into revm, which isn't on the
   plan.
4. **`bytes` / `string` shrink policy.** Finding 2: long-to-short
   updates can leave old data slots. Same shape as 2; same defer.
5. **Mapping key support for `bytes` / `string` keys.** Finding 4.
   Most ffca contracts don't use these as mapping keys; add when
   needed.
6. **Composite path decode/encode.** Finding 1 / simplification idea
   1: `StoragePathToPrimitiveType` types currently overpromise
   composite support that runtime rejects. Either narrow the types
   to leaf paths only, or implement recursive composite projection.
   Decided in `REVIEW_NOTES.md` as "leaf paths first-class for now,"
   which is fine for step 5.

The order-book port is the forcing function for #1.

### ffca runtime

What changes inside `runtime.ts` beyond the per-step diffs above:

1. **Persistence seam.** Decide whether v1 persistence consumes decoded
   `slot_writes`, explicit storage-proxy reads with app-owned indexes, or a
   small combination of both. This gates `.apply()` removal.
2. **State hydration source.** Today decoded `state.initial` / `state.load`
   seeds revm. In the longer-term canonical model, `config.state.initial` goes
   away and startup hydrates from chain storage or deployment replay. External
   token dependencies (currently invisible to ffca) need app declarations.
3. **`ffca.state` facade.** Today `ffca.state` is the direct slot-backed
   storage surface. The decoded JS read model is still maintained internally by
   `.apply()` for persistence and app-owned projections until Step 5 replaces it.

## Decisions

### Trust model: revm trusts itself

Locally-applied state is canonical. The scheduler is the only writer,
so chain confirmation is expected to match revm by construction; if it
doesn't, that's a bug, not a recoverable state. No re-execution under
chain block context, no reorg-driven replay into revm. The watch loop
still tracks confirmation depth for `MutationEvent` status transitions,
but it doesn't feed back into revm's state.

Consequence: `revertBundle` exists in the sidecar API for in-bundle
failure isolation only. There is no "rollback because chain disagreed"
path in v1.

### `ffca.state` survives the swap, backed by slot decoding

Stays as a public surface. Backed by `storage-layout` over revm's
`slot_writes` (from `execute`) and `readStorage` (for ambient reads).
No view-function `call` path — see "no view-function reads" below.
Apps declare which paths they care about; `ffca.state` projects them.
Deleting `ffca.state` is a future option, not now.

Open design note: `ffca.state` likely needs an explicit confidence view rather
than one global latest value. Apps may want to expose state at different
lifecycle thresholds, such as accepted/local, included/proposed, safe, or
finalized. The revm-backed projection should leave room for configuring which
view backs `ffca.state` and persistence reads, instead of assuming every reader
wants the most optimistic local state.

### `.apply()` stays until persistence has a revm-backed replacement

`.apply()` is now a projection, not an acceptance gate. Removing it before
persistence/read-model design is settled would remove the only mechanism that
keeps decoded tables and app APIs current. The next step is to make persistence
consume revm-backed state, then delete `.apply()` as a mechanical follow-up.

### No view-function reads

The sidecar does not (and will not) expose `call`. State reads happen
through slot decoding only. Trade-off: requires the
`matchStorageWrites` + path-registry work in `storage-layout` before
step 5 can land. Upside: one read path instead of two, mappings stay
honest about needing a registry, and slot subscriptions / state-sync
fall out naturally later. Apps that today reach for view-function
results in `persistState` will need to switch to decoded slot writes
or to deriving the same value from `args`.

### `encodeBundleArg` stays

The bundle calldata format is an `ffca` convention and stays
hand-rolled in TS. revm sees the wrapped calldata as opaque bytes and
executes it against the contract's `execute` function. A TS encoding
bug surfaces as a revm revert under canonical mode — that's enough
validation; no need to derive the calldata from revm.

### Process lifetime: restart from scratch

The sidecar holds canonical state in RAM with no persistence. On
restart today, runtime boots a fresh sidecar, loads bytecode from chain, seeds
storage from decoded persisted state via `storageLayout`, and starts from there.
The long-term goal is to hydrate revm from chain storage or deployment replay so
the database is a rebuildable read model instead of the source for revm boot.
Accepted-but-unsubmitted mutations are still an open runtime failure/restart
policy problem.

## Open decisions

### Block context: how does revm pick `block.number` / `block.timestamp`?

Inherited from the prior plan. The scheduler picks block context when
broadcasting; revm executes before broadcast. Options:

- revm executes against "latest chain block + 1" context, hopes the
  chain agrees.
- revm uses `block.timestamp = now` etc., accepts that the chain may
  pick a different timestamp.
- The scheduler controls block context end-to-end (e.g. on a PRoP
  rollup) → revm and chain match by construction.

Affects whether revm-derived access lists / gas estimates are exact or
just close. Park until we know which model the deployment target uses.
Gates step 4's determinism prerequisite.

### Where does initial storage come from?

Current answer: bytecode is pulled from chain with `eth_getCode`; storage is
encoded from decoded app state (`state.initial` or persisted `state.load`) using
`config.storageLayout`.

Long-term options:

- **Pull from chain at boot.** `eth_getCode` + `eth_getStorageAt`
  against `config.address` and declared dependencies. Simple, works
  against any deployment.
- **Replay the deployment tx.** Re-execute the deployment locally.
  Closer to "the contract is the spec" — also exercises the
  constructor (fixes the immutable-scheduler issue PR #13 hit without
  special-casing it).

Replay needs constructor args + deployer state at deployment time.
Current decoded-state seeding shipped sooner. Revisit chain hydration before
treating the database as rebuildable cache rather than revm's boot source.

### How do mutations declare touched paths?

**Hard prerequisite for step 5** (was contingent in earlier drafts —
no longer, since slot decoding is now the only read path). Mappings
can't be reverse-decoded from raw slots, so the runtime needs a
universe of candidate paths against which to match a slot write.

Options:

- Mutation config declares paths up front (`paths: ["balances[args.from]",
  "balances[args.to]", "totalSupply"]`). Apps own the list; mismatches
  with actual slot writes surface when decoded writes fail to match the
  declared path universe.
- Runtime derives paths from mutation calldata (parameter values feed
  template paths the framework knows about — closer to "the contract
  is the spec" but requires layout-aware codegen).
- Path registry persisted in the database, populated by observation
  (revm slot writes ∩ candidate paths from the layout, with mapping
  keys discovered from calldata/events).

The first option is the smallest viable shape — pick it for v1
unless something else forces a richer design. The order-book port is
the forcing function.

### Divergence detection

Open decision in the package roadmap. Now that Step 4 landed, revm and
chain should agree on state by construction. Detecting when they
don't — comparing account roots, periodic slot probes, log-based
reconciliation — is undefined. Park until step 4 has run long enough
in production to reveal what failure shapes look like.

## Sequenced next steps

1. **Persistence/read-model design.** Decide the v1 seam: decoded
   `slot_writes`, explicit storage-proxy reads with app-owned indexes, or both.
   This is more valuable than deleting `.apply()` immediately.
2. **Sidecar `slot_writes` (+ `logs`) in `execute` output.** Needed for the
   decoded-write persistence path. Pulls touched slots out of the journal
   alongside the existing access-list discovery.
3. **`storage-layout` `matchStorageWrites` + path registry shape.** Settle how
   mutations/apps declare known mapping paths; ship the helper. Hard
   prerequisite for decoding mapping slot writes.
4. **Storage proxy dynamic-array `.length`.** Needed for generic array reads;
   mapping enumeration remains intentionally unsupported.
5. **Step 5 — persistence callbacks consume revm-backed state.** `persistState`
   switches from JS state to decoded `slot_writes` and/or explicit storage reads.
6. **Delete `.apply()`.** Once persistence and app APIs no longer depend on the
   decoded JS projection, remove `FFCAMutationConfig.apply` and the runtime
   projection call.
7. **Sidecar `setBlockContext`.** Needed before replacing RPC gas/access-list
   simulation with revm-derived values.
8. **Step 3 — access-list + gas through revm.** Removes RPC simulation calls
   from submit after block-context semantics are settled.
9. **Initial storage source.** Replace decoded-state seeding with chain storage
   hydration or deployment replay when persistence/restart semantics are ready.
