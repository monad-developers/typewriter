# AGENTS.md - storage-layout

`storage-layout` turns Solidity compiler `storageLayout` JSON into concrete storage-slot information, decoded values, encoded slot writes, and ergonomic storage reads.

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
- `storage-layout.ts` owns Solidity storage layout resolution and type-level extraction.
- Concrete leaf validation belongs with storage-variable internals, not path parsing.
- Lower-level value encode/decode helpers are implementation details unless a concrete caller needs them.

## Mapping Limitation

`storageLayout + slot => variable` is not generally possible.

Mapping slots hash keys into one-way storage locations, so mapping keys cannot be recovered from raw slots. APIs that reverse slots to variables must use known variables/paths supplied by callers. Do not try to implement generic mapping enumeration.

Dynamic array `.length` is different: it lives at the array root slot and can be read directly.

## Performance Notes

- Storage proxy async leaf reads currently issue one getter call per leaf access. A known but unimplemented improvement is to coalesce parallel leaf reads, such as `Promise.all(...)`, into a single deduped slot request while preserving the existing sync getter behavior.

## Design Constraints

- Keep the package generic Solidity/storage logic; do not include app-specific vocabulary.
- Prefer focused vertical slices with runtime and type tests.
- Preserve loud failures for unsupported or non-concrete decode/encode paths.
- Use `abitype` for Solidity-to-TypeScript primitive mapping where appropriate, but keep storage-specific handling for packing, signed integers, mappings, arrays, structs, and `bytes`/`string`.
- Prefer Bun and `ox`; do not add dependencies unless there is a concrete need.
