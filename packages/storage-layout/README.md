# storage-layout

`storage-layout` turns Solidity compiler `storageLayout` JSON into concrete EVM storage-slot reads and writes.

It is for runtimes that work directly with account storage instead of contract view functions. Given a Solidity storage layout, it can compute slots, decode raw storage, encode raw slot writes, expose a read-only storage proxy, and match changed slots back to known Solidity paths.

## Quick Guide

The `layout` argument is the Solidity compiler `storageLayout` JSON for one contract. With Foundry, enable storage layout output and read it from the contract artifact.

```ts
import {
  applySlotWrite,
  createStorageProxy,
  decodeStoragePath,
  encodeStorage,
  encodeStorageDiff,
  encodeStoragePath,
  getStoragePath,
  getStorageSlot,
} from "storage-layout";

const ownerSlot = getStorageSlot(layout, "owner");
const balanceSlot = getStorageSlot(
  layout,
  "balances[0x1111111111111111111111111111111111111234]",
);
```

For strict `as const` layouts, path arguments are inferred from the layout. Composite paths like `metadata`, `fixedNumbers`, and `dynamicNumbers` are valid for `getStorageSlot`. `decodeStoragePath` and `encodeStoragePath` require paths that end at one concrete value.

Decode a value from raw storage:

```ts
const owner = decodeStoragePath(layout, "owner", {
  [ownerSlot]: "0x0000000000000000000000001111111111111111111111111111111111111234",
});
```

Encode one concrete path into masked slot writes:

```ts
const writes = encodeStoragePath(layout, "paused", false);
const nextSlot = applySlotWrite(writes[slot], existingSlot);
```

Encode a decoded state object into raw account storage for EVM seeding:

```ts
const storage = encodeStorage(layout, state);
```

Encode a sparse diff from decoded paths into masked slot writes:

```ts
const diff = encodeStorageDiff(layout, {
  pre: { owner: oldOwner, paused: false },
  post: { owner: newOwner, paused: true },
});
```

`StoragePathDiff` and `StorageSlotDiff` mirror geth prestate tracer diff mode: each is a sparse object with `pre` and `post` fields. Missing paths in a `StoragePathDiff` mean unchanged values. `StorageSlotDiff` uses raw slot values for compatibility with revm/geth output; a slot omitted from both sides is unchanged, and a slot present on only one side is decoded against zero/absence. `encodeStorageDiff` returns `StorageSlotWriteDiff` because encoding a path diff may only know one packed field in a slot, so its output keeps masks.

`decodeStorageDiff` can decode only values whose required raw slots are present in the diff. For long `bytes` and `string` values, a real sparse revm/geth diff that contains only changed payload slots and omits the unchanged root length slot is not enough to recover the complete decoded value, so decoding fails loudly.

Create a lazy read-only storage proxy:

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

## Storage Paths

Most APIs accept human-readable storage paths:

```text
owner
metadata.lastUpdate
balances[0x1111111111111111111111111111111111111234]
orders[3].amount
matrix[1][0]
```

Bracket syntax is parsed syntactically. Storage resolution decides whether a subscript is a fixed-array index, dynamic-array index, or mapping key from the current Solidity type.

## Mapping Keys

Mappings are not reversible from raw storage slots.

Solidity stores mapping values at:

```text
keccak256(abi.encode(key, baseSlot))
```

Given only the resulting slot, the mapping key cannot be recovered. The key must come from application facts: calldata, events, subscriptions, a persisted registry, or a path the app already requested.

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

`getStoragePath` expands reversible composites like structs and fixed arrays into leaf paths. Mapping paths require concrete keyed paths in `knownPaths`.

`decodeStorageDiff(layout, diff, knownPaths?)` accepts the same kind of concrete known path hints. This lets raw slot diffs decode keyed mappings whose slots cannot be reversed from layout alone.

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
- dynamic arrays with concrete indices and proxy `.length`
- mappings with concrete known keys
- `bytes` and `string`, including short in-slot and long out-of-slot storage forms
- nested combinations of supported types

Supported operations vary by type:

- Dynamic-array `.length` reads are supported through `createStorageProxy`.
- Concrete dynamic-array element reads and writes are supported.
- Whole dynamic-array decoding is not supported by `decodeStoragePath` because it only accepts concrete leaf paths.
- Whole dynamic-array encoding is not supported because shrinking needs an explicit stale-slot clearing policy.
- Whole mapping decoding is not possible from storage alone.
- Concrete keyed mapping values are supported.

## Unsupported

Unsupported types fail loudly rather than decoding approximately:

- `fixed<M>x<N>` and `ufixed<M>x<N>` fixed-point decimals
- internal and external function types
- contract, interface, and library types, until there is a tested policy to treat them as addresses
- user-defined value types, until their underlying type is available and tested
- `bytes` and `string` mapping keys
- constants and immutables, which are not ordinary account storage entries
- transient storage, which is separate from persistent contract storage

## Exports

The README is the public export source of truth.

Functions:

- `parseStoragePath(path)` parses a human-readable path into a structured `StoragePath`.
- `formatStoragePath(path)` formats a structured `StoragePath` back into a human-readable string.
- `getStorageSlot(layout, path)` computes the storage slot or slots for a path. Single-slot paths return one hex slot; multi-slot paths return an array of slots.
- `getStoragePath(layout, slot, knownPaths?)` matches raw slots back to reversible layout paths and optional known concrete paths. Packed fields can produce multiple matches. Mapping keys require `knownPaths`.
- `decodeStoragePath(layout, path, storage)` decodes one concrete leaf path from raw account storage.
- `encodeStoragePath(layout, path, value)` encodes one concrete leaf path value into masked slot writes.
- `decodeStorageDiff(layout, storageSlotDiff, knownPaths?)` decodes sparse raw slot diffs into sparse concrete path diffs. Mapping keys require `knownPaths`.
- `encodeStorageDiff(layout, storagePathDiff)` encodes sparse concrete path diffs into sparse masked slot-write diffs.
- `encodeStorage(layout, state)` encodes a decoded, contract-shaped state object into raw account storage.
- `createStorageProxy(layout, getSlots, knownPaths?)` creates a read-only JS-object projection over storage.
- `applySlotWrite(slotWrite, existingSlot)` applies one masked slot write to an existing 32-byte slot value.

Types:

- `StorageLayout`
- `StorageType`
- `ExtractVariableNames`
- `StoragePath`
- `ConcreteStoragePath`
- `StorageLayoutToPrimitiveType`
- `StoragePathToPrimitiveType`
- `AccountStorage`
- `SlotWrite`
- `SlotWrites`
- `StorageSlotDiff`
- `StorageSlotWriteDiff`
- `StoragePathDiff`
