# revm execution engine

Working notes for replacing ffca's TS-side state machine with revm. The
contract becomes the mutation acceptance spec: mutation calldata is executed by
revm against deployed bytecode, and revm storage is the runtime source of truth.

The swap is complete. The in-memory JS decoded state object, `.apply()`, and
`config.state.initial` have been deleted. `ffca.state` is an async storage proxy
backed by sidecar `readStorage`; `resolve` reads directly from revm; revm is the
sole acceptance gate; and accepted mutations are persisted without any TS-side
state projection. The remaining work is operational improvements and
replacing RPC simulation with revm-derived data, not recovering from a
half-finished migration.

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
  `state.load` into raw slots with `encodeStorage`, seeds revm with that
  storage, exposes storage through `ffca.state` as an async storage proxy,
  and passes the proxy to `resolve({ state, ... })`. For each queued
  mutation, runtime resolves any offchain data, executes a single-mutation
  bundle in revm, rejects on revm revert, and accepts the mutation
  directly. There is no `.apply()` and no JS decoded state object.

## Direction

revm is now the canonical execution engine and state authority. The remaining
work is replacing the remaining RPC simulation surface with revm, improving the
persistence seam for apps, and hardening boot/restart semantics — not bridging
from a TS state machine.

## Beliefs that shape the design

- **No magic.** `packages/evm` is a wrapper, not a framework. The
  protocol is "EVM operations over JSON." Anything app-shaped (bundles,
  mutations, accounts) lives one layer up in `ffca`.
- **The contract is the spec.** Once revm is canonical, there is no
  second implementation of mutation logic. Solidity is the only place
  application logic lives.
- **Persistence becomes ffca-owned.** Apps should not reimplement mutation
  persistence, lifecycle persistence, or state projection. ffca persists decoded
  mutation rows from ABI params, raw revm storage slot diffs, and the known path
  registry needed for mapping/dynamic-path reads. The only app-authored
  persistence seam left in v1 is declaring/discovering known storage paths.
  No view-function read path: revm doesn't expose `call`; everything reads
  through slot decoding.
- **Failure isolation as reorg.** Per-mutation revert and bundle revert
  are the same primitive — a journal checkpoint that may or may not be
  committed. Same primitive serves chain reorg recovery later.

## Adoption sequence

### Step 1 — Wire revm into `createFFCA`

Status: landed.

- `createFFCA` spawns one sidecar at startup (`createEVM`) and inits it
  with deployed bytecode from `eth_getCode`.
- Initial revm storage is encoded from decoded app state via `config.state.load`
  and the required `config.storageLayout`. The runtime does not hydrate storage
  from chain yet.
- `ffca.state` is an async storage proxy backed by sidecar `readStorage`.
- `resolve({ state, ... })` receives that storage proxy, not a mutable JS
  decoded state object.

### Step 2 — Promote revm to canonical for failure isolation

Status: landed.

- `structuredClone(state)` per mutation has been removed.
- The bundle Effect's outer `beginBundle` brackets all mutations in the bundle.
  If every queued mutation is rejected, runtime calls `revertBundle` to drop the
  open journal; success later calls `commitBundles` after broadcast.

### Step 3 — Promote revm to canonical for access list + gas

Status: not yet landed.

Drops `publicClient.createAccessList`, `publicClient.estimateGas`, and
`publicClient.simulateContract` from the submit fiber. revm's `simulate`
against the final bundle calldata produces both.

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

Status: fully landed.

- Mutation calldata is ABI-encoded against ffca's conventional
  `execute(Bundle[], uint256[])` shape and sent to revm as a single-mutation
  bundle.
- `MutationEvent.resolution` is still populated from TS `resolve`; revm output
  decoding for Solidity-authored resolutions is future work.
- Revm revert data is decoded through viem ABI errors where possible.
- TS `.apply()` has been deleted. `ffca.state` reads directly from revm; there
  is no JS decoded projection.
- Bundle calldata format (`encodeBundleArg`) stays as-is — revm sees it
  as opaque bytes against the contract's `execute` function. A TS
  encoding bug surfaces as a revm revert.

Determinism still matters: revm and chain must agree on block context, spec,
immutables, and any Monad-specific semantics before revm-derived gas/access-list
data can replace RPC simulation.

### Step 5 — Move persistence into ffca

Status: current target.

The app-owned persistence hooks are now the wrong abstraction. They kept the
app responsible for writing mutation rows, lifecycle transitions, and decoded
state tables after revm accepted a mutation. The new v1 target is narrower and
more mechanical:

1. **Flat decoded mutation tables.** ffca generates one flat table per mutation
   type from the mutation's ABI params using a new `abipg` package. Normal
   mutation reads need no joins. Lifecycle columns stay on the same
   per-mutation table so included / safe / finalized updates can be written
   generically by table lookup.
2. **Raw storage slot diff log.** ffca persists successful revm writes as raw
   `{ mutation_id, write_index, address, slot, prev_value, new_value }` rows.
   There is no separate current-slot snapshot table in v1; startup reconstructs
   account storage by reading the latest diff row per `(address, slot)` from the
   slot-indexed log.
3. **Known paths.** ffca persists the concrete storage paths discovered from
   calldata, signatures, resolutions, events, or explicit app declarations.
   These paths make mapping and nested dynamic reads possible after restart.

This deliberately defers storage-layout-to-Postgres state tables. Decoded state
tables can be added later as a derived projection from the raw slot diff log and
known path registry; they are not required for canonical revm restart.

The only remaining app persistence-like seam should be known-path discovery,
for example `knownPaths({ mutation, args, signature, resolution }) => string[]`.
It declares candidate storage paths; it does not write database rows or apply
state transitions.

Generic mapping enumeration is not a goal and cannot be solved from storage
alone. Apps that need "all known X" must expose keys through known paths derived
from calldata/events/resolution or explicit declarations. Dynamic-array
`.length` remains useful because the length lives in the array root slot.

### Step 6 — Delete the TS state machine

Status: landed.

The JS state object, `.apply()`, `config.state.initial`, `structuredClone`,
`applyMutation`, and the runtime projection call have all been removed.
`runtime.ts` has no JS mutation projection and no decoded state as an authority.
Bundle ordering, queueing, fan-out, submit, and watch stay in TS. revm owns
state and execution; persistence/read models are derived from revm.

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
  generated from decoded `state.load` through `config.storageLayout`.
- **Next boot path:** `eth_getCode` for `config.address`, plus raw storage
  reconstructed from the persisted slot-diff log by taking the latest
  `new_value` per `(address, slot)`. The diff table is indexed by slot so
  startup does not require a separate current-slot snapshot table.
- **Future boot path:** `eth_getCode` / `eth_getStorageAt` for `config.address`
  and declared dependencies, or local deployment replay. Replaces decoded DB
  state as the source for revm initialization.
- **Hot path:** `sendRawTransactionSync` for broadcast; watch loop's
  `eth_getBlockByNumber` polling for confirmation depth. That's it.

## What we still need to build

### Sidecar (`packages/evm`)

What's there: `init`, `beginBundle`, `execute`, `simulate`,
`commitBundles`, `revertBundle`, `readStorage`, plus access-list discovery.
Gaps:

1. **`setBlockContext({ number, timestamp, basefee?, … })`.** Today
   block context is set once via `init`. Step 3 needs to advance it
   per bundle (or per `execute`) so revm's `block.number` /
   `block.timestamp` match what the scheduler will broadcast against.
   Open decision in the package roadmap ("revm block context") gates
   the exact semantics. Sidecar surface is small either way.
2. **Slot writes in `execute` output.** Landed. `execute` now returns
   `slot_writes: [{ address, slot, prev_value, new_value }]` so ffca can persist
   the canonical raw storage diff for every accepted mutation. `simulate`
   continues to share the same wire type but returns no persisted slot writes.
   Logs are still future work: add `logs: [{ address, topics, data }]` later for
   event-driven known-path discovery and downstream state-sync.
3. **External account hydration after `init`.** Today every account
   has to be passed in `init.accounts`. For dependencies discovered
   lazily (an ERC-20 referenced via a constructor arg the scheduler
   doesn't know about), the sidecar needs `setAccount({ address,
   code, storage })` post-`init`. Defer until a real case forces it;
   eager hydration covers v1.

Deliberately not on this list: `call` (view-function read). Reading state
happens through slot decoding, not through view functions. `ffca.state` reads
from revm `readStorage`; persistence stores `slot_writes` and known paths.

### Storage-layout (`packages/storage-layout`)

What's there: `getStorageSlot`, `decodeStorage`, `encodeStorage`,
`encodeStorageState`, `decodeStorageDiff`, and `createStorageProxy` for value
types including packed slots, structs, fixed/dynamic arrays, mappings with most
key types, short and long bytes/string. `decodeStorageDiff(layout, diff,
knownPaths)` is the key primitive for turning raw revm slot diffs into decoded
path diffs when the runtime has a candidate path universe.

Gaps that improve the revm-backed persistence story. See
`packages/storage-layout/REVIEW_NOTES.md` for the full inventory:

1. **Known-path registry integration.** `decodeStorageDiff` can decode mapping
   and nested dynamic writes only when given concrete candidate paths. ffca needs
   to persist that registry and feed it into `ffca.state` / any future decoded
   projection. v1 persistence does not require storage-layout-to-PG tables.
2. **Storage proxy dynamic-array `.length`.** The runtime can already read
   concrete array element paths, but generic array consumers need `.length`.
   Unlike mappings, this is feasible because the length lives at the array root
   slot.
3. **Dynamic-array encoding with a stale-slot policy.** Per finding
   2 and the in-code TODO at `src/index.ts:198-205`: shrinking arrays
   leave old element slots behind. Decoding works; encoding is
   intentionally unimplemented. Not needed for the current read-heavy
   path — encoding is only relevant if TS writes back into revm.
4. **`bytes` / `string` shrink policy.** Finding 2: long-to-short
   updates can leave old data slots. Same shape as 3; same defer.
5. **Mapping key support for `bytes` / `string` keys.** Finding 4.
   Most ffca contracts don't use these as mapping keys; add when
   needed.
6. **Composite path decode/encode.** Finding 1 / simplification idea
   1: `StoragePathToPrimitiveType` types currently overpromise
   composite support that runtime rejects. Either narrow the types
   to leaf paths only, or implement recursive composite projection.
   Decided in `REVIEW_NOTES.md` as "leaf paths first-class for now,"
   which is fine.

The order-book port is the forcing function for #1.

### abipg (`packages/abipg`)

Status: initial package landed.

New package for ABI params -> Postgres schema mechanics. It borrows the useful
pieces from `monad-developers/pg-abi-decode` — the ABI primitive type inventory,
PGlite test style, and careful edge-case tests — but does not revive its main
architecture as-is.

The old repo's core idea was generated SQL ABI decoder functions over raw ABI
bytes. That remains useful later for debug views, backfills, or cross-checking
TypeScript decoding, but it is not the v1 ffca hot path. ffca wants to decode
mutation calldata once in TypeScript and persist typed flat mutation rows.

`abipg` v1 should instead expose runtime helpers that accept ABI params and
return Drizzle column builders with strict TypeScript types. The intended call
site is ffca table generation, not handwritten app schemas:

- Input: readonly ABI params, ideally preserved as const/literal types from
  `parseAbiParameters` or generated contract artifacts.
- Output: a Drizzle column object that can be spread into `pgTable(...)` for a
  generated flat mutation table.
- Scalar ABI params map to typed scalar columns.
- Complex ABI params that would force joins (arrays, nested tuples, ambiguous
  unnamed values) should initially map to `jsonb`, keeping mutation tables flat.
- Names should be deterministic and collision-checked. Unnamed params need a
  stable fallback such as `arg0`, `arg1`; tuple fields need prefixed names only
  when flattening stays unambiguous.

Important correction from the old repo: unsigned Solidity integer ranges do not
fit signed Postgres types at the same bit width. `uint16` cannot be `smallint`,
`uint32` cannot be `integer`, and `uint64` cannot safely be `bigint` for the
full ABI range. The `abipg` mapping should prefer correctness over compactness:
use wider signed types where safe, otherwise `numeric(78,0)`, unless an app or
future annotation explicitly narrows the domain.

Tests should use PGlite again because it is fast and exercises real Drizzle / SQL
behavior without requiring a service. The test suite should cover both generated
column metadata and actual insert/select round trips for representative ABI
params, especially integer boundaries, addresses, bytes, strings, arrays, and
tuple fallback behavior.

Current API exports only `abiParameterToColumn`, `abiParametersToColumns`, and
the matching generic return types `AbiParameterToColumn` /
`AbiParametersToColumns`. ABI type mapping documentation lives in
`packages/abipg/README.md`; the implementation keeps mapping helpers internal.

### ffca runtime

What changes inside `runtime.ts` beyond the per-step diffs above:

1. **State hydration source.** Today decoded `state.load` seeds revm.
   The next step is to remove `config.state.load` for persisted runtimes and
   hydrate revm from the persisted slot-diff log by selecting the latest
   `new_value` per `(address, slot)`. Longer term, startup hydrates from chain
   storage or deployment replay. External token dependencies (currently
   invisible to ffca) need app declarations.
2. **`ffca.state` facade.** Today `ffca.state` is the direct slot-backed
   storage surface. It may later gain an explicit confidence view
   (accepted/local, included/proposed, safe, finalized) so apps can
   choose which lifecycle threshold to read from.
3. **Generated persistence.** Replace `state.schema`, `state.load`,
   `persistMutation`, `persistState`, and `persistLifecycle` with ffca-owned
   generated schema and writes: flat decoded mutation tables, raw slot diffs,
   and persisted known paths.

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

### Persistence v1: decoded mutations, raw slot diffs, known paths

The first ffca-owned persistence layer does not generate decoded state tables
from storage layout. It persists three things:

1. **Decoded mutations.** One flat table per mutation type, generated from ABI
   params (and resolution params where present). These tables include lifecycle
   columns directly so normal reads do not need joins.
2. **Raw slot diffs.** One append-only diff table records successful revm writes:
   `{ mutation_id, write_index, address, slot, prev_value, new_value }`. There
   is no separate `storage_slots` snapshot table in v1. Startup reconstructs the
   account storage passed to `packages/evm` by reading the latest write per
   `(address, slot)` from the slot-indexed diff log.
3. **Known paths.** A persisted registry of concrete storage paths discovered
   from calldata, signatures, resolutions, events, or explicit mutation config.
   This registry is loaded at startup and supplied to `ffca.state` / storage
   diff decoding.

This keeps persistence mechanical and avoids duplicating contract state logic in
TypeScript. Storage-layout-to-Postgres decoded state tables remain a later
derived projection, not a prerequisite for removing persistence hooks.

ABI-param-to-column generation belongs in `packages/abipg`, not directly in
ffca. ffca consumes `abipg` to build the flat mutation tables; `abipg` owns the
Solidity ABI type mapping, Drizzle column typing, column naming, and PGlite
round-trip tests.

### No view-function reads

The sidecar does not (and will not) expose `call`. State reads happen
through slot decoding only. Trade-off: mappings stay honest about needing a
known-path registry. Upside: one read path instead of two, and slot
subscriptions / state-sync fall out naturally later. Apps that previously used
view-function-shaped or JS-state-shaped persistence should instead declare known
paths and read through `ffca.state`.

### `encodeBundleArg` stays

The bundle calldata format is an `ffca` convention and stays
hand-rolled in TS. revm sees the wrapped calldata as opaque bytes and
executes it against the contract's `execute` function. A TS encoding
bug surfaces as a revm revert under canonical mode — that's enough
validation; no need to derive the calldata from revm.

### Process lifetime: restart from persisted slot diffs

The sidecar holds canonical state in RAM. On restart today, runtime boots a
fresh sidecar, loads bytecode from chain, seeds storage from decoded persisted
state via `storageLayout`, and starts from there. The next persistence target
replaces decoded-state seeding with the slot-diff log: ffca loads the latest
`new_value` per `(address, slot)` and passes that raw storage into
`packages/evm`. The long-term goal is still to hydrate revm from chain storage
or deployment replay so the database is a rebuildable cache rather than revm's
boot source. Accepted-but-unsubmitted mutations are still an open runtime
failure/restart policy problem.

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
Gates Step 3's determinism prerequisite.

### Where does initial storage come from?

Current answer: bytecode is pulled from chain with `eth_getCode`; storage is
encoded from decoded app state (`state.load`) using `config.storageLayout`.

Next answer: bytecode is still pulled from chain, but storage is reconstructed
from the persisted raw slot-diff log. ffca queries the latest `new_value` per
`(address, slot)` from the slot-indexed diff table and passes those raw slots to
`packages/evm` at init. Known paths are loaded separately into ffca's path
registry; they are not part of `packages/evm`.

Long-term options:

- **Pull from chain at boot.** `eth_getCode` + `eth_getStorageAt`
  against `config.address` and declared dependencies. Simple, works
  against any deployment.
- **Replay the deployment tx.** Re-execute the deployment locally.
  Closer to "the contract is the spec" — also exercises the
  constructor (fixes the immutable-scheduler issue PR #13 hit without
  special-casing it).

Replay needs constructor args + deployer state at deployment time. The slot-diff
log is the v1 restart source; chain hydration can later make the database a
rebuildable cache rather than revm's boot source.

### How do mutations declare touched paths?

Mappings can't be reverse-decoded from raw slots, so the runtime needs a
universe of candidate paths against which to match a slot write.

V1 answer: mutation config may declare a known-path discovery function, for
example `knownPaths({ mutation, args, signature, resolution }) => string[]`.
The returned paths are persisted in the path registry. This is the only
app-authored persistence seam left; it does not write mutation rows, lifecycle
columns, slot diffs, or decoded state.

The runtime may later derive more paths automatically from calldata, event logs,
signature conventions, or layout-aware codegen. Explicit declaration is the
smallest viable shape unless the order-book port forces a richer design.

### Notes for review

- I interpreted `abiParameterToColum` as a typo and implemented the exported
  function as `abiParameterToColumn`. If the typo was intentional for an API
  compatibility reason, rename before downstream use.
- Generated mutation table naming is still intentionally undecided. Obvious
  options are `<mutation>_mutations`, `<mutation>s`, or preserving app-provided
  names. Pick this before ffca starts generating tables automatically.
- Signature persistence is still intentionally undecided. The old app-owned
  tables include signature/account columns; generated tables need a policy for
  whether signature tuple fields are always flattened into every mutation table,
  stored as one `jsonb` column, or split into a separate generated shape.
- Resolution columns are still intentionally undecided for name conflicts. A safe
  default is to prefix resolution fields with `resolution_`, but I did not encode
  that before you review the desired table shape.

### Divergence detection

Open decision in the package roadmap. Now that Step 4 landed, revm and
chain should agree on state by construction. Detecting when they
don't — comparing account roots, periodic slot probes, log-based
reconciliation — is undefined. Park until the runtime has run long enough
in production to reveal what failure shapes look like.

## Sequenced next steps

1. **Sidecar `setBlockContext`.** Needed before replacing RPC gas/access-list
   simulation with revm-derived values. Gates Step 3.
2. **Step 3 — access-list + gas through revm.** Removes RPC simulation calls
   from submit after block-context semantics are settled.
3. **Sidecar `logs` in `execute` output.** Slot writes are landed; logs remain
   useful for event-driven known-path discovery and downstream state-sync.
4. **Generated flat decoded mutation tables.** Generate one no-join table per
   mutation ABI via `abipg`, including lifecycle columns and raw calldata /
   resolution where useful. This replaces `persistMutation` and
   `persistLifecycle`.
5. **Raw slot-diff persistence + restart.** Persist
   `{ mutation_id, write_index, address, slot, prev_value, new_value }`, index
   by slot, and hydrate revm at startup from the latest write per `(address,
   slot)`. Do not add a separate current-slot snapshot table in v1.
6. **Known-path registry.** Add the remaining app seam for known-path discovery,
   persist those paths, and load them at startup for `ffca.state` / storage diff
   decoding.
7. **Remove app persistence hooks.** Delete `state.schema`, `state.load`,
   `persistMutation`, `persistState`, and `persistLifecycle` after generated
   mutation persistence and raw slot-diff restart are working.
8. **Storage proxy dynamic-array `.length`.** Needed for generic array reads;
   mapping enumeration remains intentionally unsupported.
