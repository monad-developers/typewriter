# AGENTS.md — storage-layout

`storage-layout` turns Solidity compiler `storageLayout` JSON into concrete storage-slot information. It supports ffca's revm path, where revm owns canonical EVM state and higher layers need to seed raw slots, read decoded values through a proxy, and eventually decode raw slot writes into app-shaped updates.

## Core Model

The central abstraction is `StoragePath`: a structured representation of a Solidity storage variable or sub-value. Leaf-only APIs use layout-inferred concrete path strings (`ExtractConcreteStoragePaths<Layout>`) or normalized `ConcreteStoragePath` values. Human-readable examples:

- `totalSupply`
- `metadata.lastUpdate`
- `balances[0x1234]`
- `accounts[0xabcd].orders[3].price`
- `instruments[1].bids[4200].remainingQuantity`

The implementation now supports value types, packed slots, structs, fixed and dynamic arrays, mappings with known keys, nested combinations, and `bytes` / `string` payload decoding for concrete paths. It also exposes `createStorageProxy` for ergonomic reads and `encodeStorage` for seeding decoded app state into raw slots.

## Solidity Type Inventory

The initial implementation should be driven by Solidity's storage-layout categories, not just ABI categories. Solidity compiler `storageLayout.types[*].encoding` uses four broad encodings: `inplace`, `mapping`, `dynamic_array`, and `bytes`.

Types to account for:

- Value types: `bool`, `uint<M>`, `int<M>`, `address`, `address payable`, `bytes1` through `bytes32`, enums, contract types, user-defined value types.
- ABI-visible dynamic byte types: `bytes`, `string`. In storage layout these use `encoding: "bytes"`, including Solidity's short-value in-slot optimization.
- Fixed composite types: structs and fixed-size arrays. These use `encoding: "inplace"`, but may span slots and may contain packed members.
- Dynamic composite types: dynamic arrays and mappings. Dynamic arrays use `encoding: "dynamic_array"`; mappings use `encoding: "mapping"` and require known keys.
- Nested combinations: arrays of structs, structs with mappings, mappings to structs, mappings to arrays, arrays of arrays, etc.
- Solidity language types that need an explicit policy: fixed/ufixed decimal types, function types, contract types, user-defined value types, constants, immutables, and transient storage.

Notes:

- Constants and immutables are not ordinary storage-layout entries in the same sense as state variables; do not assume they can be decoded from account storage.
- Transient storage has separate semantics from persistent storage. Treat it as out of scope until there is a concrete revm/ffca use case.
- Use `abitype` for Solidity-to-TypeScript primitive type mapping where possible, but storage-specific decoding still needs Solidity storage rules for packing, signed integers, short bytes/string, mappings, and dynamic arrays.

## Important Limitation

`storageLayout + slots => StoragePath` is not generally possible from storage layout alone.

Solidity mappings use one-way hashed locations: `keccak256(abi.encode(key, baseSlot))`. Given only the resulting slot, the mapping key cannot be recovered. Dynamic arrays are partially discoverable only when the array length slot is available and trusted. Therefore reverse mapping must use a known path universe, such as:

- Paths requested through `getStorageSlot`
- App-declared subscriptions
- Keys and indices discovered from mutation calldata or events
- A persisted path registry
- Bounded dynamic-array paths derived by reading length slots and then fetching indices

Static finite paths can be generated from layout on demand. Mapping paths and nested dynamic paths require known keys or indices.

Do not try to make generic mapping enumeration work in the proxy. It is not a missing implementation detail; it is unavailable from storage alone. Dynamic-array `.length` is different: the length lives at the array root slot and is a valid next ergonomic improvement.

## Target Functions

- `parseStoragePath(path)` parses human-readable paths into `StoragePath`.
- `formatStoragePath(path)` formats `StoragePath` back into human-readable form.
- `ExtractStoragePaths<Layout>` extracts all valid path strings, including composite paths.
- `ExtractConcreteStoragePaths<Layout>` extracts only path strings that end at one concrete leaf value.
- `getStorageSlot(layout, path)` computes storage slot hex values for a `StoragePath`; composite paths can return multiple slots.
- `normalizeConcretePath(layout, path)` validates that a path resolves to one concrete leaf value.
- `getStoragePath(layout, slot, knownPaths?)` identifies which reversible layout paths and optional known concrete paths were touched by one slot update. Mapping keys cannot be recovered from raw slots, so keyed mapping matches require `knownPaths`.
- `decodeStoragePath(layout, path, storage)` decodes a concrete leaf path from raw account storage.
- `encodeStoragePath(layout, path, value)` encodes a concrete leaf path value into masked slot writes: `{ [slot]: { value, mask } }`.
- `encodeStorage(layout, state)` encodes an app-shaped decoded object into raw account storage for revm initialization.
- `createStorageProxy(layout, getSlots, knownPaths?)` exposes concrete storage paths as an async JS object proxy. Leaf reads return promises; mappings require explicit keys or `knownPaths` hints for enumeration; dynamic-array `.length` reads the root length slot.

Lower-level value encode/decode helpers are implementation details for now. Keep the public API storage-oriented so callers only need masks at the slot-write boundary, not byte offsets or two's-complement encoding.

## Planned JS Object Layer

The intended scope extends beyond slot/path lookup. `createStorageProxy` and `encodeStorage` are the first JS object layer: they project normal JS object paths onto concrete storage reads/writes for known keys. The path DSL remains the lower-level representation; JS objects are the ergonomic app-facing representation.

Example direction:

- `{ totalSupply: 10n }` maps to `totalSupply`
- `{ metadata: { lastUpdate: 123n } }` maps to `metadata.lastUpdate`
- `{ balances: { [account]: 10n } }` maps to `balances[account]`

Keep this layer separate from path resolution so storage math remains testable independently from object projection rules.

## Design Constraints

- Keep the package generic Solidity/slot logic; do not include order-book vocabulary.
- Prefer small vertical slices with focused tests over broad partial implementations.
- Keep path parsing/rendering separate from storage-layout resolution. Bracket syntax is syntactic; whether `[3]` is an array index or mapping key is determined by the current Solidity type during resolution.
- Use `abitype` for Solidity-to-TypeScript primitive type mapping wherever the storage-layout label is also a valid ABI type. Keep storage-specific handling for structs, mappings, enums, packing, and slot math.
- Type-level filtering generics are useful here. For example, known-key registration should eventually be able to filter storage paths by mapping root/value shape so app hooks can register keys for only the mappings they actually touch, instead of accepting arbitrary path strings.
- Use Bun and `ox` APIs. Do not add dependencies unless there is a concrete need.
