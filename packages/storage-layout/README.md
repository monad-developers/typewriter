# storage-layout

`storage-layout` turns Solidity compiler `storageLayout` JSON into concrete storage-slot reads and writes.

It exists for runtimes that need to work directly with EVM storage instead of contract view functions. Given a Solidity storage layout, it can:

- compute the raw slot for a Solidity state path
- decode raw account storage into JavaScript values
- encode JavaScript values into raw slot writes
- expose an ergonomic read-only JS proxy over storage
- match changed slots back to known Solidity paths

This is used by ffca's revm path: revm owns canonical execution state, and the TypeScript runtime needs to seed storage, read state, and project slot writes into app-shaped updates.

## Quick Guide

The `layout` argument is the Solidity compiler `storageLayout` JSON for one contract. With Foundry, enable storage layout output and read it from the contract artifact.

Use human-readable storage paths for most calls:

```ts
import {
  applySlotWrite,
  createStorageProxy,
  decodeStoragePath,
  encodeStorage,
  encodeStoragePath,
  getStorageSlot,
} from "storage-layout";

const ownerSlot = getStorageSlot(layout, "owner");
const balanceSlot = getStorageSlot(
  layout,
  "balances[0x1111111111111111111111111111111111111234]",
);
```

For strict `as const` layouts, leaf-only APIs infer valid path strings from the layout. Composite paths like `metadata`, `fixedNumbers`, and `dynamicNumbers` are valid for `getStorageSlot`, but not for `decodeStoragePath` or `encodeStoragePath` because those APIs require paths that end at one concrete value.

Decode a value from raw slot storage:

```ts
const owner = decodeStoragePath(layout, "owner", {
  [ownerSlot]: "0x0000000000000000000000001111111111111111111111111111111111111234",
});
```

Encode one concrete path into masked raw slot writes:

```ts
const writes = encodeStoragePath(layout, "paused", false);
```

Each write is keyed by slot and includes `{ value, mask }`. For packed values, the mask covers only the bytes occupied by that value, so callers can merge without clobbering neighboring packed fields:

```ts
const nextSlot = applySlotWrite(writes[slot], existingSlot);
```

Encode a full decoded state object into raw account storage for EVM seeding:

```ts
const storage = encodeStorage(layout, state);
```

Create a lazy storage proxy:

```ts
const state = createStorageProxy(layout, async (slots) => {
  return sidecar.readStorage(slots);
});

const owner = await state.owner;
const balance = await state.balances[account];
const length = await state.dynamicNumbers.length;
const first = await state.dynamicNumbers[0];
```

The proxy reads only the slots needed for the accessed path. Sync getters return sync leaf values; async getters return promises at leaves.

## Mapping Keys

Mappings are the one important storage-layout limitation.

Solidity stores mapping values at:

```text
keccak256(abi.encode(key, baseSlot))
```

That means a raw slot does not reveal the mapping key that produced it. The key must come from application facts: calldata, events, subscriptions, a persisted registry, or a path the app already requested.

For APIs that need enumerable mapping keys, pass concrete mapping paths as `knownPaths`:

```ts
const state = createStorageProxy(layout, getSlots, [
  `balances[${account}]`,
  `allowances[${owner}][${spender}]`,
]);

Object.keys(state.balances); // [account]
Object.keys(state.allowances[owner]); // [spender]
```

`knownPaths` are mapping-key hints. They are not used for dynamic arrays. Dynamic-array `.length` is read from the array root slot, and individual indices are read directly. This avoids exposing stale indices after an array shrinks, because Solidity does not clear old element slots automatically.

For slot-write projection, match a changed slot against known paths:

```ts
const paths = getStoragePath(layout, changedSlot, knownPaths);
```

`getStoragePath` expands reversible composites like structs and fixed arrays into leaf paths. Mapping paths still require concrete keyed paths in `knownPaths`.

## Supported Types

Supported from Solidity `storageLayout`:

- `bool`
- `uint<M>` and `uint`
- `int<M>` and `int`
- `address`
- `bytes1` through `bytes32`
- enums, decoded as numbers
- structs
- fixed arrays
- dynamic arrays with concrete indices and `.length`
- mappings with concrete known keys
- `bytes` and `string`, including short in-slot and long out-of-slot storage forms
- nested combinations of supported types, such as arrays of structs, mappings to structs, structs with mappings, arrays of arrays, and mappings to arrays

Supported operations vary slightly by type:

- Dynamic-array `.length` reads are supported through `createStorageProxy`; concrete dynamic-array element decoding is supported through `decodeStoragePath`.
- Whole dynamic-array path decoding is not supported by `decodeStoragePath` because it only accepts concrete leaf paths.
- Whole dynamic-array encoding is not supported because shrinking needs an explicit stale-slot clearing policy.
- Concrete dynamic-array element encoding is supported.
- Whole mapping decoding is not possible from storage alone; concrete keyed mapping values are supported.

## Unsupported Or Out Of Scope

Unsupported types fail loudly rather than decoding approximately:

- `fixed<M>x<N>` and `ufixed<M>x<N>` fixed-point decimals
- internal and external function types
- contract, interface, and library types, until there is a tested policy to treat them as addresses
- user-defined value types, until their underlying type is available and tested
- `bytes` and `string` mapping keys
- constants and immutables, which are not ordinary account storage entries
- transient storage, which is separate from persistent contract storage

## API Reference

- `parseStoragePath(path)` parses a human-readable path into a structured `StoragePath`.
- `formatStoragePath(path)` formats a structured `StoragePath` back into a human-readable string.
- `ExtractStoragePaths<Layout>` extracts every valid path string from a strict layout, including composite paths.
- `ExtractConcreteStoragePaths<Layout>` extracts only path strings that end at one concrete leaf value.
- `getStorageSlot(layout, path)` computes the storage slot or slots for a concrete path. Single-slot paths return one hex slot; multi-slot paths return an array of slots.
- `normalizeConcretePath(layout, path)` parses/normalizes a path and validates that it resolves to one concrete leaf value.
- `getStoragePath(layout, slot, knownPaths?)` matches raw slots back to reversible layout paths and optional known concrete paths, primarily for keyed mappings. Packed fields can produce multiple matches. If no known paths are provided, unmatched slots throw when mappings exist because mapping keys cannot be recovered from raw slots.
- `decodeStoragePath(layout, path, storage)` decodes a concrete leaf path from raw account storage. `storage` is an object keyed by storage slot hex strings.
- `encodeStoragePath(layout, path, value)` encodes one concrete leaf path value into masked slot writes: `{ [slot]: { value, mask } }`.
- `applySlotWrite(slotWrite, existingSlot)` applies one masked slot write to an existing 32-byte slot value and returns the merged slot value.
- `encodeStorage(layout, state)` encodes a decoded, contract-shaped state object into raw account storage for seeding a local EVM from a JS state snapshot.
- `createStorageProxy(layout, getSlots, knownPaths?)` creates a read-only JS-object projection over storage. Leaf reads call `getSlots(slots)`; composite reads return sub-proxies. With an async getter, leaf values are promises. `knownPaths` provides concrete mapping paths as hints for enumerable mapping keys.
