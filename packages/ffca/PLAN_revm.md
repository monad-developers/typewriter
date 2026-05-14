# revm execution engine

Working notes for replacing ffca's TS-side state machine with revm. The
contract becomes the spec — `resolve` and `apply` go away, mutation
calldata is executed by revm against the deployed bytecode, and revm's
storage is the canonical state.

An earlier shadow-runtime attempt (PR #13, `revm-shadow-runtime`) wired
revm in alongside the TS state machine. This plan supersedes that
direction: revm becomes canonical, the TS state machine is deleted.

## What's already landed

Two packages now sit alongside `ffca`. Both are usable in isolation; no
`ffca` runtime code calls into either yet.

- **`packages/evm`** — Rust sidecar wrapping `monad-revm`, driven by
  line-delimited JSON over stdio. Spawned per `createEVM`; Effect-native
  TS client serializes calls behind a semaphore. Implemented methods:
  `init`, `beginBundle`, `execute`, `simulate`, `commitBundles`,
  `revertBundle`. `execute` returns `{ success, gas_used, output,
  access_list, revert_data? }` and runs two passes internally so the
  returned access list matches `eth_createAccessList` for warmed-slot
  gas pricing.
- **`packages/storage-layout`** — Solidity `storageLayout` JSON →
  slot/path machinery. `getStorageSlot`, `getStoragePath`,
  `decodeStorage`, `encodeStorage`, `parseStoragePath`,
  `formatStoragePath`. Supports value types, packed slots, structs,
  fixed and dynamic arrays, mappings with most key types, short and
  long `bytes`/`string` decode. Encoding is leaf-only; dynamic-array
  and composite encoding aren't implemented yet. `REVIEW_NOTES.md` is
  the canonical gap list.

## Direction

`ffca` adopts revm incrementally. At each step the TS state machine
still works; revm is added alongside, then promoted in scope, then the
TS path is deleted. No big-bang swap.

## Beliefs that shape the design

- **No magic.** `packages/evm` is a wrapper, not a framework. The
  protocol is "EVM operations over JSON." Anything app-shaped (bundles,
  mutations, accounts) lives one layer up in `ffca`.
- **The contract is the spec.** Once revm is canonical, there is no
  second implementation of mutation logic. Solidity is the only place
  application logic lives.
- **Persistence becomes derived.** Today apps own `persistMutation` /
  `persistState` and read from the JS state object. Post-swap, apps
  read from revm — either via view-function `call` or via decoded slot
  writes. Either way, persistence is a projection of revm's state, not
  a parallel ledger.
- **Failure isolation as reorg.** Per-mutation revert and bundle revert
  are the same primitive — a journal checkpoint that may or may not be
  committed. Same primitive serves chain reorg recovery later.

## Adoption sequence

Each step lands as its own change. The TS state machine stays working
through step 5 — every step preserves end-to-end behavior.

### Step 1 — Wire revm into `createFFCA` in parallel-validation mode

State stays TS-canonical. revm runs alongside as a shadow.

- `createFFCA` spawns one sidecar at startup (`createEVM`), inits it
  with the deployed contract's bytecode + initial storage (sourced from
  `eth_getCode` / `eth_getStorageAt` against `config.address` at boot).
- The bundle Effect calls `beginBundle` before its mutation loop. For
  each accepted TS mutation, also call `execute` with the same mutation
  calldata; for each TS rejection, the corresponding `execute` should
  also revert. Mismatch (TS accepts and revm reverts, or vice versa)
  logs a warning with the mutation digest. After the loop, commit or
  revert the bundle to match TS's decision.
- No persistence changes. No callers read revm state.

Outputs: a mismatch log. Surfaces revm divergence (block context,
spec, immutables, gas, …) early before revm is in any hot path.

### Step 2 — Promote revm to canonical for failure isolation

Replaces the per-mutation `structuredClone(state)` snapshot in
`runtime.ts:466-488` with revm-driven checkpoints. State still flows
through TS `apply`; revm provides the rollback primitive.

- Drop `structuredClone(state)` per mutation. Wrap each `execute` in a
  nested `beginBundle`/`revertBundle` so a TS apply throw can pop just
  that mutation's revm writes without disturbing the surrounding
  bundle's open checkpoint. The sidecar already supports a stack of
  open bundles (`Vec<BundleJournal>`); this needs nothing new.
- The bundle Effect's outer `beginBundle` brackets all mutations in the
  bundle. A bundle-wide reject (e.g. encoding error before submit)
  calls `revertBundle`; success calls `commitBundles`.

Validates checkpoint semantics under real load. Removes the
O(state-size) per-mutation clone.

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

`apply` / `resolve` callbacks are still invoked, but the source of
truth for whether a mutation succeeded is revm's `execute` result, not
a TS exception. The accepted/rejected decision in the bundle Effect
becomes "did revm's execute succeed?" instead of "did TS apply throw?"

- Mutation calldata (ABI-encoded against `config.abi`'s `execute`
  entrypoint, single-mutation bundle) goes into revm `execute`.
- `MutationEvent.resolution` is populated from revm's `output` (for
  mutations that have a `resolution` ABI declared), decoded via
  `ox`/`viem`. The TS-side `resolve` callback is no longer called;
  `verifyResolution` is gone.
- TS `apply` is still called on success, to keep state in sync for
  `ffca.state` and the persistence hooks (steps 5–6 deal with that).
- Bundle calldata format (`encodeBundleArg`) stays as-is — revm sees it
  as opaque bytes against the contract's `execute` function. A TS
  encoding bug surfaces as a revm revert.

Determinism prerequisite: revm and chain must agree on block context,
spec, immutables, and any Monad-specific semantics. The step 1
mismatch log should be silent before this step lands.

### Step 5 — Source persistence callbacks from revm

This step replaces the JS-state read path inside `persistMutation` /
`persistState`. The callback signatures stay the same; what they
*receive* changes.

Two routes exist depending on what each persistence hook reads:

1. **Hooks that already read from `args` only** (the common case for
   `persistMutation`): unaffected. `args` still flows through
   unchanged.
2. **Hooks that read from `state` to compute persisted rows**
   (typically `persistState`): need an alternate source. Two options:

   a. **View functions via sidecar `call`** — apps add view getters to
      the contract for any state they want to persist; the runtime
      exposes a `call(to, data)` helper that goes through the sidecar
      (transact-and-revert against the post-mutation state). Decode
      with `viem`/`ox` ABI tools. Closest to "the contract is the
      spec." Requires `call` in the sidecar (see "What we still need
      to build" below).
   b. **Decoded slot writes via `storage-layout`** — `execute`'s
      response gains a `slot_writes` field listing
      `{ slot, prev_value, new_value }` per touched slot;
      `storage-layout`'s `decodeStorage` projects each write back to a
      `StoragePath` and primitive value. Requires both new sidecar
      output and a known-path registry (mappings can't be reverse-
      decoded). See "What we still need to build."

Option (a) is the v1 target — fewer moving parts, no
reverse-mapping problem, fits the existing decoded-table persistence
shape (Open decision: "Persistence shape" in the package roadmap leans
this way too). Option (b) becomes useful later for state-sync / slot
subscriptions.

`persistLifecycle` is unaffected — it operates on bundle/block metadata
and doesn't read state.

### Step 6 — Delete the TS state machine

Once persistence is sourced from revm, the JS state object has no
remaining consumers other than `ffca.state`. `ffca.state` becomes a
thin facade over the chosen step-5 route (view-function `call` for v1).

- Delete `config.state.initial`, `config.state.load`,
  `config.state.schema` (state.schema's persistence covered by
  app-owned schema separately).
- Delete `FFCAMutationConfig.apply`, `.resolve`, and `.resolution`.
- Delete `structuredClone`, `resolveMutation`, `applyMutation`,
  `verifyResolution` from `runtime.ts`.
- `FFCAConfig.state` either survives as `state.hydrate(rpc)` returning
  bytecode + storage for sidecar init, or disappears entirely if the
  runtime can derive that from `config.address` alone.

After step 6, `runtime.ts` has no JS state, no `structuredClone`, no
hand-written mutation logic. Bundle ordering, queueing, fan-out, submit,
and watch stay in TS. revm owns state and execution.

## RPC budget after the swap

The submit fiber's RPC surface collapses:

- **Gone:** `simulateContract`, `createAccessList`, `estimateGas`
  (replaced by sidecar `simulate`), `getTransactionCount` (replaced
  by revm's nonce), `getBlock(blockHash)` after submit (block number /
  hash / timestamp come from `sendRawTransactionSync`'s receipt).
- **Gone from the watch loop:** chain-state reconciliation back into
  revm. revm trusts itself — the scheduler is the only writer; chain
  confirmation that disagrees is a bug, not a recoverable state.
- **One-time at boot:** `eth_getCode` / `eth_getStorageAt` for
  `config.address` and any declared dependencies. Replaces
  `config.state.initial`.
- **Hot path:** `sendRawTransactionSync` for broadcast; watch loop's
  `eth_getBlockByNumber` polling for confirmation depth. That's it.

## What we still need to build

The minimum that has to exist for steps 4 and 5 to land cleanly.

### Sidecar (`packages/evm`)

What's there: `init`, `beginBundle`, `execute`, `simulate`,
`commitBundles`, `revertBundle`, plus access-list discovery. Gaps:

1. **`call({ from, to, data }) → { output } | { revert_data }`.**
   View-function read. Transact-and-revert under the current bundle
   stack; logs/state writes are discarded. Step 5's view-function
   route requires this. Without it, `ffca.state` has to be backed by
   slot decoders, which means step 5b ships before step 5a, which is
   the harder path. Small Rust diff; mostly mirrors `simulate`
   without recording into the bundle.
2. **`setBlockContext({ number, timestamp, basefee?, … })`.** Today
   block context is set once via `init`. Step 4 needs to advance it
   per bundle (or per `execute`) so revm's `block.number` /
   `block.timestamp` match what the scheduler will broadcast against.
   Open decision in the package roadmap ("revm block context") gates
   the exact semantics. Sidecar surface is small either way.
3. **`getStorage({ address, slot }) → value`.** Direct slot read.
   Needed if step 5b lands ahead of 5a (decoded-slot-write
   persistence). Also useful for divergence detection — compare
   revm's account root against on-chain via slot probes.
4. **Logs + slot writes in `execute` output.** Today `execute`
   returns `{ success, gas_used, output, access_list, revert_data? }`.
   Add `logs: [{ address, topics, data }]` and `slot_writes: [{
   address, slot, prev_value, new_value }]`. Logs unblock event-
   driven persistence patterns; slot writes unblock step 5b and slot
   subscriptions later.
5. **External account hydration after `init`.** Today every account
   has to be passed in `init.accounts`. For dependencies discovered
   lazily (an ERC-20 referenced via a constructor arg the scheduler
   doesn't know about), the sidecar needs `setAccount({ address,
   code, storage })` post-`init`. Defer until a real case forces it;
   eager hydration covers v1.

### Storage-layout (`packages/storage-layout`)

What's there: `getStorageSlot`, `decodeStorage` for value types
including packed slots, structs, fixed/dynamic arrays, mappings with
most key types, short and long bytes/string. `encodeStorage` for leaf
values only. `getStoragePath` reverse lookup for non-mapping paths.

Gaps that block step 5b. See `packages/storage-layout/REVIEW_NOTES.md`
for the full inventory; the ones that gate revm canonical persistence:

1. **`matchStorageWrites(layout, writes, knownPaths)`.** Per
   `REVIEW_NOTES.md` finding 5 / simplification idea 2: the current
   `getStoragePath(layout, slots)` throws if any mapping exists in
   the layout, even when the changed slot is unrelated. Mappings need
   a known-path registry. The framework-side shape of that registry
   is undecided — mutations could declare touched paths up front, or
   we could derive them from mutation calldata, or maintain a
   persisted index. Pick one before step 5b.
2. **Dynamic-array encoding with a stale-slot policy.** Per finding
   2 and the in-code TODO at `src/index.ts:198-205`: shrinking arrays
   leave old element slots behind. Decoding works; encoding is
   intentionally unimplemented. Only relevant if `ffca` ever wants to
   write back to revm from TS, which isn't on this plan's path —
   defer until something needs it.
3. **`bytes` / `string` shrink policy.** Finding 2: long-to-short
   updates can leave old data slots. Same shape as 2; same defer.
4. **Mapping key support for `bytes` / `string` keys.** Finding 4.
   Most ffca contracts don't use these as mapping keys; add when
   needed.
5. **Composite path decode/encode.** Finding 1 / simplification idea
   1: `StoragePathToPrimitiveType` types currently overpromise
   composite support that runtime rejects. Either narrow the types to
   leaf paths only, or implement recursive composite projection.
   Decided in `REVIEW_NOTES.md` as "leaf paths first-class for now,"
   which is fine for step 5b.

The order-book port is the forcing function for #1. Until ffca has a
contract using mappings whose persistence shape matters, the registry
question stays academic.

### ffca runtime

What changes inside `runtime.ts` beyond the per-step diffs above:

1. **Sidecar lifecycle.** `createFFCA` spawns one sidecar on startup
   via `createEVM` and tears it down in `stop()`. The Effect scope
   used by `createEVM` needs to be threaded through `createFFCA`'s
   fiber. Wraps the existing runtime fiber start/stop.
2. **State hydration source.** `config.state.initial` becomes
   optional in step 1 (still required for the TS path) and goes away
   in step 6. In its place: an `eth_getCode` + `eth_getStorageAt`
   walk against `config.address` at startup. For external token
   dependencies (currently invisible to ffca), apps will need to
   declare them — open decision.
3. **`ffca.state` facade.** In steps 1–4, unchanged. In step 5a, a
   thin wrapper around sidecar `call` that decodes view-function
   output with `viem`/`ox`. Apps declare which getters they call;
   ffca caches the ABI; the wrapper is mechanical. In step 5b (if
   ever taken), backed by `getStorage` + `decodeStorage`.

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

### `ffca.state` survives the swap

Stays as a public surface. v1 backs it by view-function `call` (apps
declare the getter surface, `ffca.state` is a thin facade). When the
slot-decoder route is justified, it can back `ffca.state` instead with
no caller-visible change. Deleting `ffca.state` is a future option,
not now.

### `encodeBundleArg` stays

The bundle calldata format is an `ffca` convention and stays
hand-rolled in TS. revm sees the wrapped calldata as opaque bytes and
executes it against the contract's `execute` function. A TS encoding
bug surfaces as a revm revert under canonical mode — that's enough
validation; no need to derive the calldata from revm.

### Process lifetime: restart from scratch

The sidecar holds canonical state in RAM with no persistence. On
restart, runtime boots a fresh sidecar, re-hydrates from chain
(`eth_getCode` + `eth_getStorageAt`), and starts from there. Any
accepted-but-unsubmitted mutations are lost. Persistence is a future
problem, not v1.

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

### Where does the deployed bytecode + initial storage come from?

- **Pull from chain at boot.** `eth_getCode` + `eth_getStorageAt`
  against `config.address` and declared dependencies. Simple, works
  against any deployment.
- **Replay the deployment tx.** Re-execute the deployment locally.
  Closer to "the contract is the spec" — also exercises the
  constructor (fixes the immutable-scheduler issue PR #13 hit without
  special-casing it).

Replay needs constructor args + deployer state at deployment time.
Pull-from-chain ships sooner. Start with pull, revisit when external
dependencies get complex.

### How do mutations declare touched paths?

Needed if step 5b ever lands. Options:

- Mutation config declares paths up front (`paths: ["balances[args.from]",
  "balances[args.to]", "totalSupply"]`). Apps own the list; mismatches
  with actual slot writes surface in step 1's mismatch log.
- Runtime derives paths from mutation calldata (parameter values feed
  template paths the framework knows about).
- Path registry persisted in the database, populated by observation
  (revm slot writes ∩ candidate paths from the layout).

No forcing function until 5b is real. Listed so it doesn't get
rediscovered.

### Divergence detection

Open decision in the package roadmap. Once step 4 lands, revm and
chain should agree on state by construction. Detecting when they
don't — comparing account roots, periodic slot probes, log-based
reconciliation — is undefined. Park until step 4 has run long enough
in production to reveal what failure shapes look like.

## Sequenced next steps

1. **Step 1 — parallel-validation wire-up in `createFFCA`.** No
   behavior change. Logs revm/TS mismatches. This is the first
   concrete piece of work; everything before it is already merged.
2. **Sidecar `setBlockContext`.** Needed before step 4 for
   determinism. Small Rust diff.
3. **Sidecar `call`.** Needed for step 5a. Mirrors `simulate`
   without journaling.
4. **Step 2 — failure-isolation swap.** Drops `structuredClone`.
5. **Step 3 — access-list + gas through revm.** Removes three RPC
   calls from submit.
6. **Step 4 — revm-decided acceptance.** TS `apply` still runs;
   revm decides reject/accept. Mismatch log should already be silent.
7. **Step 5a — `ffca.state` and persistence through view-function
   `call`.**
8. **Step 6 — delete TS state machine.** `config.state.*`,
   `mutation.apply`, `mutation.resolve` removed.
