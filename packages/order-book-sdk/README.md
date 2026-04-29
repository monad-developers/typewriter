# Order Book SDK

Shared constants, types, and math utilities for the order book exchange. Used by the backend, frontend, and scripts packages.

## Install

Already available as a workspace dependency:

```ts
import { TokenAmount, INSTRUMENTS, USD } from "order-book-sdk";
```

## TokenAmount

Converts between human-readable amounts and raw 18-decimal on-chain values.

```ts
// From human-readable
const amount = TokenAmount.from(1000, USD);
amount.raw    // 1000000000000000000000n (1000 * 10^18)
amount.human  // 1000
amount.asset  // "0x1111..."

// From raw units (e.g. reading from chain state)
const amount = TokenAmount.fromRaw(500000000000000000n, GOLD);
amount.human  // 0.5
```

## Lots

Orders use **lots**, not raw token amounts. A lot is the minimum tradable unit, defined per instrument:

```
1 base lot  = 2^baseLotExp  raw base units
1 quote lot = 2^quoteLotExp raw quote units
```

```ts
import { toLots, fromLots } from "order-book-sdk";

const lots = toLots(amount.raw, instrument.baseLotExp);
const raw = fromLots(lots, instrument.baseLotExp);
```

## Prices (Q32.32 fixed-point)

Prices are stored on-chain as Q32.32 fixed-point integers:

```
q32Price = humanPrice * 2^(32 + baseLotExp - quoteLotExp)
```

```ts
import { priceToQ32, q32ToPrice } from "order-book-sdk";

const q32 = priceToQ32(2400, INSTRUMENTS["GOLD/USD"]);
const price = q32ToPrice(q32, INSTRUMENTS["GOLD/USD"]); // 2400
```

## baseToQuote

Converts a base token amount to the equivalent quote amount at a given Q32 price:

```ts
import { baseToQuote, TokenAmount, INSTRUMENTS } from "order-book-sdk";

const inst = INSTRUMENTS["GOLD/USD"];
const gold = TokenAmount.from(1, inst.base);
const q32 = priceToQ32(2400, inst);
const usd = baseToQuote(gold, q32, inst);
usd.human // ~2400
```

## Constants

### Tokens

| Name   | Address                                      |
|--------|----------------------------------------------|
| USD    | `0x1111111111111111111111111111111111111111` |
| GOLD   | `0x2222222222222222222222222222222222222222` |
| WTIOIL | `0x3333333333333333333333333333333333333333` |
| EUR    | `0x4444444444444444444444444444444444444444` |
| SPX    | `0x5555555555555555555555555555555555555555` |
| BTC    | `0x6666666666666666666666666666666666666666` |

### Instruments

| Name       | ID | Base   | Quote | baseLotExp | quoteLotExp |
|------------|----|--------|-------|------------|-------------|
| GOLD/USD   | 0  | GOLD   | USD   | 35         | 46          |
| WTIOIL/USD | 1  | WTIOIL | USD   | 40         | 46          |
| EUR/USD    | 2  | EUR    | USD   | 46         | 46          |
| SPX/USD    | 3  | SPX    | USD   | 34         | 46          |
| BTC/USD    | 4  | BTC    | USD   | 29         | 46          |

### Other exports

- `ASSETS` — `[USD, GOLD, WTIOIL, EUR, SPX, BTC]`
- `EIP712_TYPES` — EIP-712 type definitions for all exchange mutations
- `EXCHANGE_ABI` — Solidity ABI for the Exchange contract
- `InstrumentConfig` — TypeScript type for instrument configuration
