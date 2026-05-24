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
  order-book/           # FFCA-backed order book app, contracts, frontend, SDK, scripts, tests, and docs

packages/
  ffca-evm/             # ffca-evm sidecar package
  ffca/                 # framework for crypto apps (work in progress)
```

The app serves the frontend, hosts the FFCA runtime that batches and submits to the contract, and exposes the API the scripts drive against. See the in-app `/about` page for an architectural walkthrough — message lifecycle, accounts/keys/nonces, censorship resistance, force-exit, gas figures.

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Monad Foundry](https://github.com/category-labs/foundry) — the `category-labs` fork of Foundry, not upstream `foundry-rs`. Install by downloading the latest release for your platform and placing the binaries on your PATH. The fork is required because the test suite verifies gas estimation parity between the revm sidecar and `eth_estimateGas`, which only holds under Monad gas rules. Anvil must be started with `--monad` to enable those rules — the test setup does this automatically, but any manual `anvil` invocation needs the flag too.
- Postgres (for the backend)

## Quick start

```bash
bun install
```

Run Anvil (the `--monad` flag is required for Monad gas rules):

```bash
anvil --monad --block-time 0.4
```

In another terminal, deploy the Exchange to local Anvil:

```bash
cd apps/order-book
cp .env.example.local .env
bun run deploy
```

In another terminal, start the backend (which serves the frontend):

```bash
cd apps/order-book
cp .env.example.local .env
bun dev
```

Open <http://localhost:3000>. Sign up with WebAuthn, deposit, then place orders — or run a participant script:

```bash
cd apps/order-book
cp .env.example .env
bun scripts/add-instrument.ts
PRICE=2400 SIDE=buy QUANTITY=1 INSTRUMENT=GOLD/USD bun scripts/limit-order.ts
```

See [apps/order-book/scripts/README.md](apps/order-book/scripts/README.md) for the full script catalog.

## Scripts

```bash
bun run lint       # Lint all workspaces
bun run typecheck  # Type-check all workspaces
bun run build      # Build all workspaces
```
