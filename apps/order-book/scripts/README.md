# Order Book Scripts

Scripts for interacting with the order book. Each script emulates a specific market participant.

## Setup

```bash
cd apps/order-book
```

Order-book uses one root `.env` file. Start from the app-level example:

```bash
cp .env.example.local .env
```

Scripts require `API_URL`, and read the chain and order book address from the backend's `/api/manifest`.

## Scripts

### seed

Registers every instrument and places limit orders around its price. `bun dev` seeds its own chain, so run this only against a new deployment.

```bash
bun scripts/seed.ts
```

### limit-order

Places a limit order (maker). Deposits the required tokens automatically.

```bash
PRICE=2400 SIDE=buy QUANTITY=1 INSTRUMENT=GOLD/USD bun scripts/limit-order.ts
PRICE=70 SIDE=sell QUANTITY=10 INSTRUMENT=WTIOIL/USD bun scripts/limit-order.ts
PRICE=1.10 SIDE=buy QUANTITY=1000 INSTRUMENT=EUR/USD bun scripts/limit-order.ts
PRICE=5200 SIDE=sell QUANTITY=0.5 INSTRUMENT=SPX/USD bun scripts/limit-order.ts
PRICE=95000 SIDE=buy QUANTITY=0.01 INSTRUMENT=BTC/USD bun scripts/limit-order.ts
```

### market-order

Places a market order (taker). Reads the order book to determine the exact fill, deposits accordingly.

```bash
SIDE=buy QUANTITY=0.5 INSTRUMENT=GOLD/USD bun scripts/market-order.ts
SIDE=sell QUANTITY=2 INSTRUMENT=GOLD/USD bun scripts/market-order.ts
```

### market-maker

Places limit orders on both sides of the book at 1bp, 5bp, 10bp, and 25bp from the mid price. Reads the current price from the book, or accepts `PRICE` as an anchor if there's no existing liquidity.

```bash
QUANTITY=1 INSTRUMENT=GOLD/USD bun scripts/market-maker.ts
QUANTITY=2 INSTRUMENT=GOLD/USD PRICE=2400 bun scripts/market-maker.ts
```

### arbitrage

Trades against mispriced orders. Takes a `PRICE` anchor and executes market orders against any asks below or bids above that price.

```bash
PRICE=2400 INSTRUMENT=GOLD/USD bun scripts/arbitrage.ts
PRICE=70 INSTRUMENT=WTIOIL/USD bun scripts/arbitrage.ts
PRICE=1.10 INSTRUMENT=EUR/USD bun scripts/arbitrage.ts
PRICE=5200 INSTRUMENT=SPX/USD bun scripts/arbitrage.ts
PRICE=95000 INSTRUMENT=BTC/USD bun scripts/arbitrage.ts
```

### retail

Simulates a retail trader. Picks a random side (50/50) and random quantity from a fixed set, then executes a market order.

```bash
INSTRUMENT=GOLD/USD bun scripts/retail.ts
```

## Writing a script

Create a new `.ts` file in `scripts/`. Import what you need from `order-book-sdk` and the backend client in `scripts/src/client.ts`; `scripts/src/env.ts` reads the common env vars:

```ts
import { INSTRUMENTS, TokenAmount } from "order-book-sdk";
import { createAccount, deposit, limitOrder } from "./src/client";

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

Run it with `bun scripts/my-script.ts` from `apps/order-book/` so Bun loads the app-level `.env`.

## Client reference

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
await changeOrder(account, { orderId, instrument, price });
```

### Concurrent transactions

Pass `{ concurrent: true }` to send multiple mutations in parallel:

```ts
await Promise.all([
  deposit(account, { quantity: usd }, { concurrent: true }),
  deposit(account, { quantity: gold }, { concurrent: true }),
]);
```

### Reads

```ts
await fetchPrice(instrumentId); // { price, bestBid, bestAsk, spread }, Q32 prices
await fetchTicks(instrumentId, [{ side, priceQ32 }]);
await fetchAccountOrders(account.accountID, instrumentId);
await estimateMarketOrder({ instrumentId, side, quantityLots });
await estimateFillToPrice({ instrumentId, side, priceQ32 });
```
