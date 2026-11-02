# Perps

A perpetual futures exchange on Typewriter: a price-time order book per market, cross margin in one collateral, an admin-pushed oracle and funding rate, and liquidations the server runs as soon as an account falls below maintenance margin.

It is an example, not a production exchange. One admin account lists markets, prices them, credits deposits, accrues funding, and liquidates. See [TYPEWRITER_GAPS.md](./TYPEWRITER_GAPS.md) for where Typewriter forced those choices.

## Run

```bash
cd apps/perps && cp .env.example.local .env && bun dev
```

`bun dev` starts Anvil, deploys `Perps`, claims the admin seat with the server's key, lists the markets in `sdk/index.ts`, and starts a dev market maker that quotes a ladder around each oracle price. The oracle is a random walk; `POST /api/dev/oracle` moves it by hand.

`scripts/liquidation.ts` opens a ~9.3x BTC long, drops the oracle 8%, and waits for the liquidator:

```bash
bun scripts/liquidation.ts
```

Contract tests: `bun run contracts:test`.

## Model

- **Units.** Collateral is a 6-decimal dollar. Sizes are signed whole lots; `MARKETS` in the SDK gives each market's lot size. Prices are collateral units per lot, on the market's `tickSize`.
- **Positions.** A position stores its size, its signed cost (`size × entry`), and the market's funding index when it last traded. A trade that reduces it realizes PnL into collateral pro rata to cost.
- **Equity** is collateral, plus `size × oracle − cost` for each position, minus funding owed since its index.
- **Initial margin** applies to the worst case if every resting order fills: `max(|size + bids|, |size − asks|) × oracle × IM`. Orders, trades that grow a position, and withdrawals need equity ≥ initial margin afterwards. Trades that shrink a position don't.
- **Maintenance margin** is `|size| × oracle × MM`. Below it, the admin can liquidate.
- **Funding** is a per-lot index: `AccrueFunding` adds to it, longs pay when it rises. The server sets it to the book's premium over the oracle, clamped to ±0.5% per 8 hours, scaled by the time since the last accrual.
- **Matching.** Makers settle at fill time, since every position must be current for margin. Taking your own resting order cancels it.
- **Fees.** Taker and liquidation fees go to the insurance fund. When a liquidation leaves an account with no positions and negative collateral, the insurance fund absorbs the debt.

## Mutations

| Mutation | Who | Params | Does |
| --- | --- | --- | --- |
| `SetAdmin` | first caller, then admin | `admin` | Claims the empty admin seat for the caller, or hands it on |
| `AddMarket` | admin | `marketId, tickSize, oraclePrice, initialMarginBps, maintenanceMarginBps, takerFeeBps, liquidationFeeBps` | Lists a market |
| `UpdateMarket` | admin | `marketId, status, initialMarginBps, maintenanceMarginBps, takerFeeBps, liquidationFeeBps` | Changes risk params; `status` is `Active`, `ReduceOnly` (nothing that grows a position or worst case), or `Halted` (no trading) |
| `SetOraclePrices` | admin | `prices: {marketId, price}[]` | Sets mark prices |
| `AccrueFunding` | admin | `fundings: {marketId, fundingPerLot}[]` | Adds to funding indexes |
| `Deposit` | admin | `account, amount` | Credits collateral that arrived outside the app |
| `Liquidate` | admin | `account, marketId, quantity, limitPrice` | For an account below maintenance: cancels all its orders, closes up to `quantity` lots against the book no worse than `limitPrice`, charges the liquidation fee |
| `CancelOrder` | owner | `orderId` | Cancels a resting order |
| `LimitOrder` | user | `marketId, side, price, quantity` | Post-only: rests on the book, reverts if it would cross |
| `MarketOrder` | user | `marketId, side, quantity, limitPrice` | Fill-or-kill against the book no worse than `limitPrice`, pays the taker fee |
| `Withdrawal` | user | `amount` | Debits settled collateral, keeping initial margin; the payout happens outside the app |

Batches run `SetAdmin → AddMarket → UpdateMarket → Deposit → SetOraclePrices → AccrueFunding → CancelOrder → LimitOrder → Liquidate → MarketOrder → Withdrawal`: a batch trades at its own oracle price, and liquidations reach fresh quotes before takers do.

## Server

| File | Does |
| --- | --- |
| `src/app.ts` | Starts Typewriter with batch sequencing |
| `src/admin.ts` | The server's admin account: signs admin mutations on random nonce lanes, claims the seat at startup |
| `src/read.ts` | Read model over `app.state`; `health` mirrors `Margin.sol` |
| `src/liquidator.ts` | After every accepted batch, scans accounts and liquidates each one below maintenance, largest position first, until it is healthy. Backs off 5s after a rejection |
| `src/oracle.ts` | Dev price feed, pushed every `ORACLE_INTERVAL_MS` |
| `src/funding.ts` | Accrues funding every `FUNDING_INTERVAL_MS` |
| `src/market-maker.ts` | Dev-only maker |

### API

| Route | Returns |
| --- | --- |
| `GET /api/manifest` | Typewriter manifest for signing |
| `POST /api` | Submits a signed mutation (superjson); `{ executionIndex, status: "accepted" }` or 400 with the revert |
| `GET /api/exchange` | Admin, insurance fund, and every market |
| `GET /api/markets/:id?depth=20` | A market and its book |
| `GET /api/accounts/:id` | Collateral, equity, margins, positions, and orders |
| `GET /api/liquidations` | The liquidator's last 50 attempts |
| `POST /api/dev/faucet` | Dev only: `{ account, amount }` admin `Deposit` |
| `POST /api/dev/oracle` | Dev only: `{ marketId, price }` sets an oracle price |

## Deploy

Put `PRIVATE_KEY` (the scheduler) and `RPC_URL` in `.env`, then:

```bash
bun run deploy
```

Then run `bun start` with `PERPS_ADDRESS`, `PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`, `CHAIN_ID`, `RPC_URL`, and `DATABASE_URL`. The first start claims the admin seat for `ADMIN_PRIVATE_KEY`'s account; anyone who submits `SetAdmin` before it can take the seat instead.
