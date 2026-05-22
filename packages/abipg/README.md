# abipg

Runtime ABI params to Drizzle Postgres columns.

`abipg` is for generating flat mutation table columns from ABI params at runtime.
It does not decode ABI bytes inside Postgres. ffca decodes calldata in
TypeScript, then inserts typed values into the generated columns.

## Type Mapping

| ABI type | Postgres type | TypeScript insert type | Notes |
| --- | --- | --- | --- |
| `bool` | `boolean` | `boolean` | ABI boolean value. |
| `address` | `char(42)` | `string` | Hex address with `0x` prefix. |
| `uint8` | `smallint` | `number` | Full unsigned range fits in signed `smallint`. |
| `uint16`, `uint24` | `integer` | `number` | Full unsigned range fits in signed `integer`. |
| `uint32`, `uint40`, `uint48`, `uint56` | `bigint` | `bigint` | Full unsigned range fits in signed `bigint`. |
| `uint64` through `uint256` | `numeric(78,0)` | `string` | Full unsigned range does not fit in signed `bigint`. |
| `int8`, `int16` | `smallint` | `number` | Full signed range fits in signed `smallint`. |
| `int24`, `int32` | `integer` | `number` | Full signed range fits in signed `integer`. |
| `int40`, `int48`, `int56`, `int64` | `bigint` | `bigint` | Full signed range fits in signed `bigint`. |
| `int72` through `int256` | `numeric(78,0)` | `string` | Full signed range does not fit in signed `bigint`. |
| `bytes1` through `bytes32` | `char(2 + 2N)` | `string` | Fixed-size byte arrays as fixed-length `0x` hex strings. |
| `bytes` | `text` | `string` | Dynamic bytes as variable-length `0x` hex string. |
| `string` | `text` | `string` | UTF-8 string value. |
| `function` | `char(50)` | `string` | 24-byte Solidity function pointer as `0x` hex string. |
| `fixed<M>x<N>`, `ufixed<M>x<N>` | `numeric(78,0)` | `string` | Decimal ABI types are rare; keep exact decimal storage. |
| `tuple` | `jsonb` | ABI-shaped JSON | Complex values stay in the flat mutation row without joins. |
| `T[]`, `T[N]` | `jsonb` | ABI-shaped JSON | Arrays stay in the flat mutation row without joins. |

For `jsonb` complex values, `bigint` leaves are represented as decimal strings
because JSON has no bigint type.
