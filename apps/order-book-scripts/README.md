# Order Book Scripts

Scripts for interacting with the order book exchange. Each script emulates a specific market participant.

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
# EXCHANGE_ADDRESS=0x6805712E440BA1FE8DdF48A91eb8Ab9f0BaCaA03
```

## Scripts

### add-instrument

Registers instruments on the exchange. Run this first.

```bash
bun src/add-instrument.ts
```

### limit-order

Places a limit order (maker). Deposits the required tokens automatically.

```bash
PRICE=2400 SIDE=buy QUANTITY=1 INSTRUMENT=GOLD/USD bun src/limit-order.ts
PRICE=70 SIDE=sell QUANTITY=10 INSTRUMENT=WTIOIL/USD bun src/limit-order.ts
```

### market-order

Places a market order (taker). Reads the order book to determine the exact fill, deposits accordingly.

```bash
SIDE=buy QUANTITY=0.5 INSTRUMENT=GOLD/USD bun src/market-order.ts
SIDE=sell QUANTITY=2 INSTRUMENT=GOLD/USD bun src/market-order.ts
```

### market-maker

Places limit orders on both sides of the book at 1bp, 5bp, 10bp, and 25bp from the mid price. Reads the current price from the book, or accepts `PRICE` as an anchor if there's no existing liquidity.

```bash
QUANTITY=1 INSTRUMENT=GOLD/USD bun src/market-maker.ts
QUANTITY=2 INSTRUMENT=GOLD/USD PRICE=2400 bun src/market-maker.ts
```

### arbitrage

Trades against mispriced orders. Takes a `PRICE` anchor and executes market orders against any asks below or bids above that price.

```bash
PRICE=2400 INSTRUMENT=GOLD/USD bun src/arbitrage.ts
PRICE=70 INSTRUMENT=WTIOIL/USD bun src/arbitrage.ts
```

### retail

Simulates a retail trader. Picks a random side (50/50) and random quantity from a fixed set, then executes a market order.

```bash
INSTRUMENT=GOLD/USD bun src/retail.ts
```

## Writing a script

Create a new `.ts` file in `src/`. Import what you need from `order-book-sdk` and the local SDK:

```ts
import { TokenAmount, INSTRUMENTS } from "order-book-sdk";
import { createAccount, deposit, limitOrder } from "./sdk";

const inst = INSTRUMENTS["GOLD/USD"];
const account = await createAccount();

// Deposit 1000 USD
await deposit(account, { quantity: TokenAmount.from(1000, inst.quote) });

// Place a bid for 0.5 GOLD at $2400
await limitOrder(account, {
  instrument: inst,
  quantity: TokenAmount.from(0.5, inst.base),
  price: 2400,
  side: "buy",
});
```

Run it with `bun src/my-script.ts`.

## SDK reference

### Account

```ts
const account = await createAccount();
const account = await createAccount("0xabc..."); // existing private key
```

### Mutations

```ts
await deposit(account, { quantity });
await withdraw(account, { quantity });
await limitOrder(account, { instrument, quantity, price, side });
await marketOrder(account, { instrument, quantity, minReceived, side });
await closeOrder(account, { orderId });
```

### Concurrent transactions

Pass `{ concurrent: true }` to send multiple mutations in parallel:

```ts
await Promise.all([
  deposit(account, { quantity: usd }, { concurrent: true }),
  deposit(account, { quantity: gold }, { concurrent: true }),
]);
```

### State

```ts
const state = await fetchState();
// state.instruments[0] — order book, ticks
// state.accounts["0x..."] — balances, keys, nonces
```
