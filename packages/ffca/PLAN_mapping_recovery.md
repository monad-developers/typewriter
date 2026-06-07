# Mapping Key Recovery Plan

## Goal

Recover mapping keys (and full storage paths) automatically from EVM execution,
and **remove `registerMappingKeys` entirely**. Apps should no longer declare
which mapping entries a mutation touches; the runtime should observe it.

## Why this matters

Today a raw 32-byte storage slot for a mapping value cannot be reversed back into
the `(mapping, key)` it came from. The slot is a one-way hash:

```
slot(mapping[key]) = keccak256(pad(key) ‖ baseSlot)
```

`storage-layout`'s reverse resolver (`getStorageVariable`) throws on mapping
slots unless the caller supplies the concrete keys as `knownVariables`. The
framework works around this with `registerMappingKeys` (`src/config.ts:23-33`):
a per-mutation app callback that, given `args` / `signature` / `resolution`,
returns the storage paths the mutation touches. Those paths are persisted to
`known_paths` and reloaded on startup to make mappings enumerable/decodable.

This pushes a correctness burden onto every app. Each mutation must hand-maintain
a list of touched paths that exactly mirrors its on-chain logic. Drift between the
contract and the callback silently loses state. The order-book `MarketOrder` case
is the worst of it: its callback has to consume the computed `resolution` (fills)
just to know which price levels were hit (`apps/order-book/src/app.ts:230-243`).

But the information is never actually missing — it is in EVM memory at execution
time. Solidity computes the mapping slot with the `KECCAK256` (SHA3, `0x20`)
opcode over a 64-byte region laid out as `pad(key) ‖ baseSlot`. The preimage —
both the key and the parent slot — exists the instant the hash is computed. We
just aren't watching for it. If we record every `KECCAK256` preimage during
execution plus the set of slots actually touched, any touched slot that matches a
recorded hash output is a mapping access, and the preimage hands us
`(key, parentSlot)`. Walking the chain of preimages reconstructs the full path.

This is a known technique (Foundry and Hardhat reverse storage slots the same
way). revm needs **no extra input** — the preimages are already in memory. We
only need to install an inspector to capture them.

## Approach

Three layers, bottom-up. Rust captures raw evidence; `storage-layout`
reconstructs typed paths; `ffca` feeds them into the existing `known_paths`
pipeline. `ffca`'s persistence/dedup/reload machinery does not change — only the
*source* of the paths changes from app callbacks to execution capture.

### Layer 1 — `ffca-evm` (Rust): capture keccak preimages + touched slots

`execute()` currently installs no inspector (`harness.rs` builds with
`build_monad()`). Install a revm `Inspector` (`build_monad_with_inspector`, which
the monad-revm dep tree already supports) that records, during execution:

- **Keccak preimages**: for every `KECCAK256` opcode, the input bytes (read from
  interpreter memory via the offset/size on the stack) and the resulting hash.
- **Touched slots**: `SLOAD` / `SSTORE` slots, per contract address. (The
  existing post-hoc `collect_access_list` already yields touched slots from the
  journaled state; the inspector path can subsume or complement it.)

Filtering to keep the payload small and noise-free:

- Only retain preimages whose output hash appears in the touched-slot set, **or**
  whose output is itself consumed as the parent of another retained preimage
  (needed for nested mappings — an inner hash is a parent, not a touched slot).
  Simplest correct first cut: retain all 32- and 64-byte-input preimages, let TS
  filter. Optimize later if payload size matters.
- `KECCAK256` is also used for ABI encoding, `CREATE2`, etc. Those are discarded
  by the slot/parent cross-reference in Layer 2; Rust stays dumb.

Surface the capture in the wire types:

- Add a field to `ExecuteOk` (`harness.rs:126-153`) and `ExecuteResult`
  (`src/types.ts:43-57`), e.g. `keccak_preimages: { hash: Hex; preimage: Hex }[]`,
  serialized as hex like `slot_writes`.

**Critical: three-pass execution.** `run_two_pass` (`harness.rs:420-530`) runs the
tx up to three times (discovery, gas measurement, final). The inspector must
reset between passes (natural reset points are alongside each `self.evm.finalize()`
at `harness.rs:451,478`). Only the final pass's preimages are reported.

### Layer 2 — `storage-layout`: reconstruct typed paths from evidence

Add a reverse resolver that takes `(layout, touchedSlots, preimages)` and returns
storage-variable selector strings (the same path syntax `registerMappingKeys`
returned, e.g. `accounts[0x..].balance`).

Algorithm, per touched slot `S`:

1. Build a `hash -> preimage` index from the preimage list.
2. Resolve `S` against the static (non-mapping) layout first
   (`getStorageVariable`'s existing reversible-slot set). If it matches, done.
3. Otherwise walk the hash chain. Find a recorded hash `H` where
   `0 <= S - H < structSize` (the offset handles struct-valued mappings, see
   below). `H`'s preimage is either:
   - **64 bytes** → mapping access: first 32 = `pad(key)`, last 32 = `parentSlot`.
     Decode `key` via the mapping's key type (inverse of `encodeMappingKey`,
     `storage-layout.ts:548-631`). Recurse on `parentSlot`.
   - **32 bytes** → dynamic array data region: `parentSlot` = the 32 bytes,
     element index = `S - keccak(parentSlot)`. Recurse on `parentSlot`.
4. Recursion terminates when `parentSlot` is a literal base slot matching a
   mapping/array root in the layout. Validate the assembled path resolves
   forward to `S` via `getStorageSlot` (cheap correctness check; rejects the
   stray non-storage `KECCAK256` false positives).

Cases in scope (core):

- **Single-level mappings** — `m[k]`.
- **Nested mappings** — `m[a][b]`: chained hashes `keccak(b ‖ keccak(a ‖ p))`.
- **Dynamic arrays** — `keccak(slot)` base, index by subtraction.
- **Struct-valued mappings** — `m[k].field`: slot is `keccak(k ‖ p) + offset`;
  the `0 <= S - H < structSize` window recovers key + field.

Out of scope for this plan (stretch, see below): dynamic `bytes`/`string`
mapping keys (variable-length preimage, not 64 bytes).

### Layer 3 — `ffca`: drive `known_paths` from execution, delete the callback

- `execute()` results already flow through `executeMutation`
  (`runtime.ts:215-261`). Replace the `registerKnownPaths` call
  (`runtime.ts:183-192, 254-261`) with a call into the Layer 2 resolver, fed by
  the new `keccak_preimages` + touched slots from the `ExecuteResult` and the
  app's `storageLayout`.
- The recovered paths flow into the existing `knownPaths` accumulation, dedup,
  `known_paths` persistence, and startup reload unchanged
  (`runtime.ts:535,646-650,713-717`; `db-query.ts:247-280`).
- **Remove `registerMappingKeys`**: delete `RegisterMappingKeys` and the field
  from `FFCAMutationBase` (`src/config.ts:23-33`), the internal mirror
  (`src/internal.ts:7-17`), `registerKnownPaths` and `RegisterKnownPathsError`
  (`runtime.ts:183-192,201-206`), and the per-mutation usages in
  `apps/token/src/app.ts` and `apps/order-book/src/app.ts`.

## Wire shape sketch

```rust
// harness.rs — appended to ExecuteOk
struct KeccakPreimage { hash: String, preimage: String } // both 0x-hex
struct ExecuteOk { /* …existing… */ keccak_preimages: Vec<KeccakPreimage> }
```

```ts
// ffca-evm/src/types.ts — appended to ExecuteResult
keccak_preimages: { hash: Hex.Hex; preimage: Hex.Hex }[];
```

```ts
// storage-layout — new export
function recoverStoragePaths(
  layout: StorageLayout,
  touchedSlots: readonly Hex[],
  preimages: readonly { hash: Hex; preimage: Hex }[],
): readonly string[];
```

## Rollout order

1. `ffca-evm` Rust: add the inspector, capture preimages + touched slots, reset
   per pass, report final pass only. Add `keccak_preimages` to `ExecuteOk`.
2. `ffca-evm` TS: add `keccak_preimages` to `ExecuteResult`. Add a unit test that
   a simple `mapping(address => uint)` write produces a 64-byte preimage whose
   hash equals the written slot.
3. `storage-layout`: implement `recoverStoragePaths` with the four core cases.
   Test against fixtures covering single/nested mappings, dynamic arrays, and
   struct-valued mappings. Assert recovered paths round-trip through
   `getStorageSlot`.
4. `ffca` runtime: swap `registerKnownPaths` for `recoverStoragePaths`. Keep the
   `known_paths` persistence/reload path intact.
5. Delete `registerMappingKeys` from `ffca` config/internal and from both apps.
6. Verify order-book and token e2e tests still enumerate/decode mapping state,
   especially `MarketOrder` (previously the resolution-dependent callback).

## Validation target

The first proof point: a `MarketOrder` mutation, with `registerMappingKeys`
removed, still persists exactly the price-level paths it touched — recovered from
execution instead of from the resolution callback — and state reads enumerate the
same entries as before.

## Non-goals

- Per-opcode read/write ordering or sub-call trace surfaces beyond what path
  recovery needs.
- Dynamic `bytes`/`string` mapping keys (see stretch).
- Generic mapping enumeration of *untouched* keys. Recovery is still bounded to
  what a mutation actually accessed — same scope as `registerMappingKeys` had,
  just sourced automatically.
- Replacing the napi/JSON transport or `run_two_pass`'s gas strategy.

## Stretch

- **Dynamic-key mappings.** The preimage contains the raw key bytes even when the
  key is `bytes`/`string`, so this approach *could* support keys that
  `registerMappingKeys` and `storage-layout` reject today. The preimage is
  `key_bytes ‖ slot` (length `len(key)+32`, not 64). Out of core scope, but the
  capture makes it newly possible.
- **Escape hatch.** Pure-assembly contracts that compute a slot without a
  `KECCAK256` (precomputed/manual slots) won't be observed. The decision here is
  **full removal** of `registerMappingKeys`; if such a contract appears, revisit
  whether a narrow opt-in override is warranted rather than keeping the callback
  for everyone.

## Open decisions

- **Preimage filtering location.** Retain-all-in-Rust + filter-in-TS (simple) vs.
  cross-reference against touched slots in Rust (smaller payload, but Rust needs
  to track parent-of relationships for nested mappings). Start simple; measure.
- **Touched slots: reads too?** Path recovery needs both reads and writes (a
  mutation may read a mapping entry it doesn't write). Confirm the inspector
  captures `SLOAD` slots, not just `SSTORE`, and reconcile with the existing
  `access_list` so there's one source of touched slots.
- **Struct window bound.** Resolving `m[k].field` needs the struct size to bound
  `S - H`. Confirm `storage-layout` exposes enough type info to compute the
  per-mapping value struct size, or derive it during the walk.
- **Failure mode on unrecoverable slot.** If a touched mapping slot has no
  matching preimage chain (e.g. assembly-computed), does recovery throw, warn, or
  silently skip? With `registerMappingKeys` gone there is no fallback, so this
  needs an explicit, loud policy.
- **Inspector overhead.** Hooking `KECCAK256` on three passes has a cost. Confirm
  it's acceptable for the accept-latency budget, or restrict capture to the final
  pass by construction rather than by reset.
