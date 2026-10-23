# abipg

TypeScript utilities for creating Drizzle Postgres database objects from ABI parameters.

## API

- `abiParameterToColumn(param)`: one `NOT NULL` Drizzle column for one ABI parameter.
- `abiParametersToColumns(params)`: one column per parameter. A column has the parameter name, or `arg<index>` if the parameter has no name. Duplicate names throw.
- `abiParametersToValues(params, values)`: the insert values for these columns. `values` is a positional array, or an object keyed by column name.

All three throw `unsupported ABI type` or `invalid ABI integer type` for a type that has no mapping, including a type inside a tuple or an array.

## Type Mapping

| ABI type | Postgres type | TypeScript insert type | Notes |
| --- | --- | --- | --- |
| `bool` | `boolean` | `boolean` | ABI boolean value. |
| `address` | `char(42)` | `` `0x${string}` `` | Lowercase hex. |
| `uint8` | `smallint` | `number` | Full unsigned range fits in signed `smallint`. |
| `uint16`, `uint24` | `integer` | `number` | Full unsigned range fits in signed `integer`. |
| `uint32`, `uint40`, `uint48`, `uint56` | `bigint` | `bigint` | Full unsigned range fits in signed `bigint`. |
| `uint64` through `uint256`, `uint` | `numeric(78,0)` | `bigint` | Full unsigned range does not fit in signed `bigint`. |
| `int8`, `int16` | `smallint` | `number` | Full signed range fits in signed `smallint`. |
| `int24`, `int32` | `integer` | `number` | Full signed range fits in signed `integer`. |
| `int40`, `int48`, `int56`, `int64` | `bigint` | `bigint` | Full signed range fits in signed `bigint`. |
| `int72` through `int256`, `int` | `numeric(78,0)` | `bigint` | Full signed range does not fit in signed `bigint`. |
| `bytes1` through `bytes32` | `char(2 + 2N)` | `` `0x${string}` `` | Fixed-size bytes as lowercase hex. |
| `bytes` | `text` | `` `0x${string}` `` | Dynamic bytes as lowercase hex. |
| `string` | `text` | `string` | See [Strings](#strings). |
| `function` | `char(50)` | `` `0x${string}` `` | 24-byte function pointer as lowercase hex. |
| `tuple` | `jsonb` | ABI-shaped JSON | See [JSON values](#json-values). |
| `T[]`, `T[N]` | `jsonb` | ABI-shaped JSON | See [JSON values](#json-values). |

`fixed<M>x<N>` and `ufixed<M>x<N>` are not supported. Solidity does not allow them in function signatures.

Integer inputs can be `number`, `bigint`, or a decimal string.

## Hex values

`abiParametersToValues` stores `address`, `bytes`, `bytes<N>` and `function` values as lowercase hex, at the top level and inside `jsonb`. A checksummed address and a lowercase address therefore give the same row.

## Strings

Postgres `text` cannot hold U+0000, and `jsonb` cannot hold a lone UTF-16 surrogate. `abiParametersToValues` replaces both with U+FFFD, in `string` columns and in strings inside `jsonb`. UTF-8 encoding of calldata already replaces lone surrogates with U+FFFD, so only U+0000 differs from the onchain value.

## JSON values

`abiParametersToValues` builds `jsonb` values from the ABI types, so the shape does not depend on the input:

- A tuple is an object keyed by component name when every component has a name. Otherwise it is a positional array. A named tuple accepts object or positional input.
- An integer of 48 bits or fewer is a JSON number. A wider integer is a decimal string, because JSON has no bigint type. This matches the `number` and `bigint` types that abitype gives.
- Hex and string values follow the rules above.
