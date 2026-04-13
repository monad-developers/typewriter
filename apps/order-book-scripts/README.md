# Order Book Scripts

Scripts for interacting with the order book exchange. Uses an SDK that handles account creation, EIP-712 signing, and nonce management.

## Setup

```bash
cd apps/order-book-scripts
```

Configure the environment in `.env` (or set env vars directly):

```bash
# Local development (Anvil) — these are the defaults
API_URL=http://localhost:3000
CHAIN_ID=31337
EXCHANGE_ADDRESS=0x5fbdb2315678afecb367f032d93f642f64180aa3

# Monad testnet
# API_URL=https://order-book-frontend-production.up.railway.app
# CHAIN_ID=10143
# EXCHANGE_ADDRESS=0x96614160AB7Ce07469D179B6424e784e4Ce1F885
```

## Running existing scripts

```bash
# Add instruments to the exchange
bun src/setup.ts

# Place a limit order (provide liquidity)
PRICE=2400 SIDE=buy QUANTITY=1 bun src/liquidity.ts
PRICE=2400 SIDE=sell QUANTITY=0.5 INSTRUMENT="GOLD/USD" bun src/liquidity.ts

# Run arbitrage against mispriced orders
PRICE=2500 bun src/arbitrage.ts
PRICE=90 INSTRUMENT="WTIOIL/USD" bun src/arbitrage.ts
```

## Writing a script

Create a new `.ts` file in `src/`. Import what you need from the SDK and constants:

```ts
import { INSTRUMENTS, USD } from "./constants";
import { createAccount, deposit, limitOrder, TokenAmount } from "./sdk";

const inst = INSTRUMENTS["GOLD/USD"];
const account = await createAccount();

// Deposit 1000 USD
await deposit(account, TokenAmount.from(1000, inst, "quote"));

// Place a bid for 0.5 GOLD at $2400
await limitOrder(account, {
  amount: TokenAmount.from(0.5, inst, "base"),
  price: 2400,
  side: "buy",
});
```

Run it with `bun src/my-script.ts`.

## SDK reference

### Account

```ts
// Creates a new account (generates key, initializes on-chain if needed)
const account = await createAccount();

// Or use an existing private key
const account = await createAccount("0xabc...");
```

### TokenAmount

Wraps a token amount with its instrument context. Handles conversion between human-readable amounts, raw units, and lots.

```ts
// From human-readable
const gold = TokenAmount.from(0.5, inst, "base");   // 0.5 GOLD
const usd = TokenAmount.from(1000, inst, "quote");   // 1000 USD

// From raw units (e.g. reading from chain state)
const amount = TokenAmount.fromRaw(500000000000000000n, inst, "base");

// Properties
amount.human   // number — human-readable (e.g. 0.5)
amount.raw     // bigint — raw token units (e.g. 500000000000000000n)
amount.lots    // bigint — lot count for this instrument
amount.asset   // Address — token address
```

### Mutations

```ts
await deposit(account, amount);
await withdraw(account, amount);
await limitOrder(account, { amount, price, side: "buy" | "sell" });
await marketOrder(account, { amount, minReceived, side: "buy" | "sell" });
await closeOrder(account, { orderId });
```

- `amount`: a `TokenAmount` — specifies which token and how much
- `price`: human-readable price (e.g. `2400` for $2400/GOLD)
- `side`: `"buy"` or `"sell"`
- `minReceived`: a `TokenAmount` for the minimum acceptable fill

### Concurrent transactions

By default, mutations are sequential (each gets an incrementing nonce). To send multiple mutations in parallel, pass `{ concurrent: true }`:

```ts
const inst = INSTRUMENTS["GOLD/USD"];

await Promise.all([
  deposit(account, TokenAmount.from(1000, inst, "quote"), { concurrent: true }),
  deposit(account, TokenAmount.from(0.5, inst, "base"), { concurrent: true }),
]);
```

Each concurrent mutation uses an independent random nonce, so they don't depend on ordering.

### Price helpers

```ts
// Human-readable price -> Q32 fixed-point
const q32 = priceToQ32(2400, INSTRUMENTS["GOLD/USD"]);

// Q32 fixed-point -> human-readable price
const price = q32ToPrice(q32, INSTRUMENTS["GOLD/USD"]);
```

### State

```ts
const state = await fetchState();
// state.instruments[0] - instrument data (order book, ticks)
// state.accounts["0x..."] - account data (balances, keys, nonces)
```

## Units

### Token amounts

Token amounts have two representations:

- **Human-readable**: `0.5` GOLD, `1000` USD
- **Raw**: the on-chain integer, scaled by `10^decimals` (e.g. `500000000000000000n` for 0.5 tokens with 18 decimals)

Use `TokenAmount` to convert between them:

```ts
const amount = TokenAmount.from(1000, inst, "quote");  // 1000 USD
amount.raw    // 1000000000000000000000n (1000 * 10^18)
amount.human  // 1000
```

### Lots

Orders use **lots**, not raw token amounts. A lot is the minimum tradable unit, defined per instrument:

```
1 base lot  = 2^baseLotExp  raw base units
1 quote lot = 2^quoteLotExp raw quote units
```

For GOLD/USD with `baseLotExp=35`: 1 lot = 2^35 = ~34 billion raw units, which at 18 decimals is ~0.000000034 GOLD (~$0.0001 worth at $2400).

`TokenAmount` handles lot conversion automatically — you work in human amounts and the SDK converts to lots internally:

```ts
const amount = TokenAmount.from(0.5, inst, "base");
amount.lots   // lot count, used internally by limitOrder/marketOrder
```

### Prices (Q32 fixed-point)

Prices are stored on-chain as **Q32.32 fixed-point** integers. This encodes the price as the ratio of quote lots to base lots, scaled by 2^32:

```
q32Price = humanPrice * 2^32 * 2^(quoteLotExp - quoteDecimals) / 2^(baseLotExp - baseDecimals)
```

The SDK functions accept human-readable prices (e.g. `2400`) and convert internally. If you need the Q32 value directly:

```ts
const q32 = priceToQ32(2400, INSTRUMENTS["GOLD/USD"]);  // $2400 -> Q32
const human = q32ToPrice(q32, INSTRUMENTS["GOLD/USD"]);  // Q32 -> $2400
```

## Constants

Edit `src/constants.ts` to configure token addresses and instruments:

```ts
export const USD: Address = "0x1111111111111111111111111111111111111111";
export const GOLD: Address = "0x2222222222222222222222222222222222222222";

export const INSTRUMENTS = {
  "GOLD/USD": {
    id: 0,
    base: GOLD,
    quote: USD,
    baseLotExp: 35,     // 1 base lot = 2^35 raw units
    quoteLotExp: 46,    // 1 quote lot = 2^46 raw units
    baseDecimals: 18,
    quoteDecimals: 18,
  },
} as const;
```
