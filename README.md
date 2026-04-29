# tx-lifecycle-demo-app

Demos for visualizing the lifecycle of a transaction on Monad — from user signing through pre-confirmation, voting, and finalization.

The headline demo is an **on-chain order book**: a Bun backend that accepts signed mutations over HTTP, bundles them, submits them to the Exchange contract, and streams every state transition to a live frontend. The repo also includes a simpler ERC20 token demo from an earlier experiment, kept for reference.

## Apps

```
apps/
  order-book-backend/   # Bun + React + Postgres backend; live UI showing block/mutation/account state
  order-book-contracts/ # Exchange.sol + Account.sol; batch execution, EIP-712 signed mutations, P256/WebAuthn auth
  order-book-scripts/   # CLI scripts emulating market participants (limit, market, market-maker, retail, arbitrage)
  token-contracts/      # earlier experiment: ERC20 token (Foundry)
  token-frontend/       # earlier experiment: React frontend showing tx lifecycle for token transfers

packages/
  order-book-sdk/       # shared types and math (TokenAmount, instruments, price/quantity conversion)
```

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Foundry **nightly**](https://book.getfoundry.sh/getting-started/installation) — `foundryup --install nightly`. The Exchange contract uses the P256 precompile at `address(0x100)` (RIP-7212), which stable Foundry does not include. Required for both `forge test` and `anvil`.
- Postgres (for the order-book backend)

## Quick start — order book

```bash
bun install
```

Deploy the Exchange to local Anvil:

```bash
cd apps/order-book-contracts
cp .env.example.local .env
bun run dev    # runs anvil + deploys Exchange
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

## Quick start — token demo (earlier experiment)

A simpler demo from before the order book — useful if you just want to see a single ERC20 transfer move through the lifecycle.

```bash
cd apps/token-contracts
cp .env.example.local .env
bun run dev          # anvil + auto-deploys the token

# in another terminal
cd apps/token-frontend
cp .env.example.local .env
bun dev
```

## Scripts

```bash
bun run lint       # Lint all workspaces
bun run typecheck  # Type-check all workspaces
bun run build      # Build all workspaces
```
