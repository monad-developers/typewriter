# AGENTS.md - storage-layout

`storage-layout` turns Solidity compiler `storageLayout` JSON into decoded storage values, typed storage selectors, and a lazy object view of contract storage.

The public API is `decodeStorageVariable`, `createStorageView`, the viem actions (`readStorageVariable`, `readStorageVariables`), the enumeration helpers (`enumerateMappingKeys`, `getDynamicArrayLength`), and the types exported from `src/index.ts`. Keep the export surface small: export a helper only when a concrete caller needs it.

## Core Model

The public abstraction is a storage variable selector string:

- `totalSupply`
- `metadata.lastUpdate`
- `balances[0x1234]`
- `accounts[0xabcd].orders[3].price`

Path syntax is syntactic only. Whether `[3]` is an array index or mapping key is determined by the current Solidity storage type during resolution.

## Boundaries

Keep path parsing/formatting separate from layout resolution.

- `storage-path.ts` should stay about parsing, formatting, and path syntax.
- `storage-layout.ts` owns the compiler JSON types and runtime resolution of a path to one `StorageLocation` (`{ type, slot, offset }`).
- `types.ts` owns the type-level API: selector extraction and Solidity-to-TypeScript value types.
- `solidity-encoding.ts` owns low-level Solidity rules shared by the modules above: value-type classification (`parseValueType`), the mapping-key codec (`encodeMappingKey` / `decodeMappingKey`, which must stay exact inverses), and slot math.
- `decodeStorageVariable.ts` owns leaf decoding, including the `bytes`/`string` length rules (`bytesLength`, `MAX_BYTES_LENGTH`). The view and the viem actions use `bytesLength` too, so a check added there covers every API.
- `account-storage.ts` reads slot words from `AccountStorage` with keys in any hex form, and owns the slot getter types and `fetchStorage` (dedupe, call the getter, check one value per slot) that the view and the viem actions share. Sync and async getters are handled with an explicit `instanceof Promise` branch where needed, not a generic continuation helper.
- `readStorageVariable.ts` / `readStorageVariables.ts` validate selectors before any request, read root slots, then read `bytes`/`string` data slots. They assume that all requests see the same state, by choice for now: they do not detect a new block between requests.
- Concrete leaf validation belongs with the function that needs a leaf (for example `decodeStorageVariable`), not path parsing or resolution.

## Mapping Limitation

`storageLayout + slot => variable` is not generally possible.

Mapping slots hash keys into one-way storage locations, so mapping keys cannot be recovered from raw slots. Keys are known only from keccak256 preimages that the caller captured during execution (`enumerateMappingKeys`, and enumeration in `createStorageView`). Do not try to recover keys from slots or storage values alone.

Dynamic array `.length` is different: it lives at the array root slot and can be read directly.

## Testing

- Run tests with `bun run test` from this directory, not raw `bun test`: the script runs `contracts:build` first. Foundry (`forge`, `anvil`) must be on `PATH`.
- `bun run contracts:build` runs `forge build --root test/contracts` and `scripts/generateTypedArtifacts.ts`, which writes the gitignored `test/contracts/generated.ts` (ABI, bytecode, and solc `storageLayout` as `as const` literals). `typecheck` and `build` also run it, because tests import that file.
- `test/anvil.ts` follows viem's test setup: a prool proxy server with one anvil instance per pool id. `test/setup.ts` (preloaded by `bunfig.toml`) starts one proxy per test process on a free port, so `bun test --parallel` is safe. Anvil starts lazily, on the first RPC request. `stepsTracing` is on so `debug_traceTransaction` returns struct logs with memory.
- `src/ground-truth.test.ts` is the source of truth for encoding rules. It compares every decoded value with the Solidity getter of `StorageFixture.sol`, and mapping enumeration with preimages from the `populate()` trace. When you add support for a Solidity type, add a variable of that type to `StorageFixture.sol`, write it in `populate()`, and compare it with its getter there. Hand-written layouts in `test/utils.ts` are for focused unit cases only.
- Prefer one shared fixture contract over many small ones: solc assigns the slots, so a new variable does not need test updates elsewhere.

## Type Performance

The selector types expand every path of a layout, so careless generics make `tsc` very slow. A full package typecheck is about 0.3M instantiations and under 1 s. If it grows by a large amount, find the cause with `tsc --extendedDiagnostics` and `--generateTrace`. Keep these rules:

- In a public generic function, pass a generic selector to a `string` parameter as `variable as unknown as string`, and cast results the same way. Relating `variable extends ConcreteStorageVariable<layout>` to `string` directly makes TypeScript expand the selector types for a loose layout, which costs seconds per call site.
- Type aliases that take a selector (`StorageVariableToPrimitiveType`, `MappingEntryVariable`, the read parameter types) leave it unconstrained and narrow with `variable extends string` inside, for the same reason.
- Wrap computed public return types in `NoInfer<...>`. Without it, a call nested in another generic call (`expect(decodeStorageVariable(...))`, `Promise.all([...])`) makes TypeScript walk the return type before it infers the selector: millions of instantiations per call site.

## Performance Notes

- `bun run benchmark` (`scripts/benchmark.ts`) replays the read patterns of `apps/order-book` (linked-list price walks, depth, order and credential scans, mapping enumeration) against `test/contracts/src/OrderBookFixture.sol`, with a global `preimages` array like the typewriter runtime's. It reports time, getter calls, and slots read per call. Run it before and after a performance change, and profile one case with `BENCH_CASE=<name> bun --cpu-prof-md scripts/benchmark.ts`.
- The storage view is deliberately stateless for now: no cache and no key index. Each leaf access issues one getter call, and mapping enumeration and membership checks scan `preimages`. Because `Object.keys` checks membership once per listed key, enumerating a mapping costs keys × preimages string comparisons. A faster design is planned; measure it with `bun run benchmark`.
- A known but unimplemented improvement is to coalesce parallel async leaf reads, such as `Promise.all(...)`, into a single deduped slot request.

## Design Constraints

- Keep the package generic Solidity/storage logic; do not include app-specific vocabulary.
- Prefer focused vertical slices with runtime and type tests.
- Preserve loud failures for unsupported or non-concrete decode paths.
- Use `abitype` for Solidity-to-TypeScript primitive mapping where appropriate, but keep storage-specific handling for packing, signed integers, mappings, arrays, structs, and `bytes`/`string`.
- Prefer Bun and `ox` in `src/`. `viem` is a peer dependency (`^2.56.9`, the first version with `getStorageValues`) used only by the viem actions; keep it out of the decoders. `prool` is a dev dependency for the anvil tests.
