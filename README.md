# tx-lifecycle-demo-app

A demo app for visualizing the lifecycle of Ethereum transactions. Includes a Solidity ERC20 token contract and a React frontend.

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil, cast)

## Project Structure

```
apps/
  contracts/   # Solidity contracts (ERC20 Token), Foundry project
  frontend/    # React + Tailwind frontend served via Bun
```

## Environment Variables

| Variable | Used By | Default | Description |
|---|---|---|---|
| `BUN_PUBLIC_RPC_URL` | frontend | `http://localhost:8545` | JSON-RPC URL the frontend connects to |
| `DEPLOYER_PRIVATE_KEY` | frontend | Anvil account #0 | Private key used to fund new accounts on sign-in |
| `RPC_URL` | contracts | — | JSON-RPC URL for contract deployment |
| `TOKEN_NAME` | contracts | — | Name of the deployed ERC20 token |
| `TOKEN_SYMBOL` | contracts | — | Symbol of the deployed ERC20 token |
| `TOKEN_DECIMALS` | contracts | — | Decimals for the deployed ERC20 token |

## Quick Start

Install dependencies:

```bash
bun install
```

Start the contracts app (runs Anvil + auto-deploys the token):

```bash
cd apps/contracts
bun run dev
```

In another terminal, start the frontend:

```bash
cd apps/frontend
bun dev
```

## Scripts

```bash
bun run lint       # Lint all packages
bun run typecheck  # Type-check all packages
bun run build      # Build all packages
```
