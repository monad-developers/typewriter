# tx-lifecycle-demo-app

A demo app for visualizing the lifecycle of Ethereum transactions. Includes a Solidity ERC20 token contract and a React frontend. Supports local development (Anvil) and Monad testnet.

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

Each app has its own `.env` file. See `.env.example.local` and `.env.example.testnet` in each subdir for ready-to-use templates.

### Frontend (`apps/frontend/.env`)

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Yes | Private key used to fund new accounts on sign-in |
| `BUN_PUBLIC_TOKEN_ADDRESS` | Yes | Deployed token contract address |
| `BUN_PUBLIC_RPC_URL` | Yes | JSON-RPC URL the app connects to |
| `BUN_PUBLIC_CHAIN_ID` | Yes | Chain ID (31337 for Anvil, 10143 for Monad testnet) |

### Contracts (`apps/contracts/.env`)

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Yes | Private key used to deploy the contract |
| `RPC_URL` | Yes | JSON-RPC URL for contract deployment |

## Quick Start

Install dependencies:

```bash
bun install
```

Set up env files by copying the relevant example in each subdir:

```bash
# For local development:
cp apps/contracts/.env.example.local apps/contracts/.env
cp apps/frontend/.env.example.local apps/frontend/.env

# For Monad testnet:
cp apps/contracts/.env.example.testnet apps/contracts/.env
cp apps/frontend/.env.example.testnet apps/frontend/.env
# Then fill in DEPLOYER_PRIVATE_KEY and BUN_PUBLIC_TOKEN_ADDRESS
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
