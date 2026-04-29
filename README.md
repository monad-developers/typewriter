# exchange-demo

An experimental on-chain order book on Monad testnet.

A self-contained exchange stack — contracts, server, and live UI — that demonstrates what becomes possible when transactions confirm in milliseconds. Everything settles onchain; the server is non-custodial, can't front-run, and can be bypassed via a force-exit queue if it stalls.

## Features

- **Cancel prioritization.** Orders are sequenced cancel → limit → market within each batch, so quote updates are never stuck behind incoming flow.
- **50ms batch windows.** Every order submitted within a window clears together — a burst doesn't advantage whoever's closer to the node.
- **Pro-rata matching.** Fills at the clearing price are allocated proportionally to order size, not arrival time.
- **Modern auth.** Passkey at sign-in, ephemeral session keys (P-256, IndexedDB-backed) for order placement.
- **Self-contained stack.** No third-party sequencers, relays, wallets, or proposer-builder auctions.
- **Non-custodial with a trustless exit.** Balances, orders, and matching rules all live onchain; users can force-include orders directly against the contract without backend cooperation.

## Layout

```
apps/
  order-book-backend/   # Bun + React + Postgres backend; live UI showing block/mutation/account state
  order-book-contracts/ # Exchange.sol + Account.sol; batch execution, EIP-712 signed mutations, P256/WebAuthn auth
  order-book-scripts/   # CLI scripts emulating market participants (limit, market, market-maker, retail, arbitrage)

packages/
  order-book-sdk/       # shared types and math (TokenAmount, instruments, price/quantity conversion)
```

The backend serves the frontend, hosts the runtime that batches and submits to the contract, and exposes the API the scripts drive against. See the in-app `/about` page for an architectural walkthrough — message lifecycle, accounts/keys/nonces, censorship resistance, force-exit, gas figures.

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Foundry **nightly**](https://book.getfoundry.sh/getting-started/installation) — `foundryup --install nightly`. The Exchange contract uses the P256 precompile at `address(0x100)` (RIP-7212), which stable Foundry does not include. Required for both `forge test` and `anvil`.
- Postgres (for the backend)

## Quick start

```bash
bun install
```

Run Anvil:

```bash
anvil --block-time 0.4
```

In another terminal, deploy the Exchange to local Anvil:

```bash
cd apps/order-book-contracts
cp .env.example.local .env
bun run deploy
```

In another terminal, start the backend (which serves the frontend):

```bash
cd apps/order-book-backend
cp .env.example.local .env
bun dev
```

Open <http://localhost:3000>. Sign up with WebAuthn, deposit, then place orders — or run a participant script:

```bash
cd apps/order-book-scripts
cp .env.example .env
bun scripts/add-instrument.ts
PRICE=2400 SIDE=buy QUANTITY=1 INSTRUMENT=GOLD/USD bun scripts/limit-order.ts
```

See [apps/order-book-scripts/README.md](apps/order-book-scripts/README.md) for the full script catalog.

## Scripts

```bash
bun run lint       # Lint all workspaces
bun run typecheck  # Type-check all workspaces
bun run build      # Build all workspaces
```

## Earlier experiment

[apps/token-contracts](apps/token-contracts/) and [apps/token-frontend](apps/token-frontend/) are an earlier ERC20 transfer demo, kept for reference. Not the focus of this repo.
