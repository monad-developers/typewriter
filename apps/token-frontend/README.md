# token-frontend

React + Tailwind frontend for the token-transfer demo, served via [Bun](https://bun.sh). Earlier experiment kept for reference; see the repo root README for the current focus.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Yes | Private key used to fund new accounts on sign-in |
| `BUN_PUBLIC_TOKEN_ADDRESS` | Yes | Deployed token contract address |
| `BUN_PUBLIC_RPC_URL` | Yes | JSON-RPC URL the app connects to |
| `BUN_PUBLIC_CHAIN_ID` | Yes | Chain ID (31337 for Anvil, 10143 for Monad testnet) |

Copy `.env.example.local` or `.env.example.testnet` to `.env`. Bun loads `.env` automatically.

## Usage

Install dependencies:

```bash
bun install
```

Start a development server (with HMR):

```bash
bun dev
```

Run for production:

```bash
bun start
```

Build:

```bash
bun run build
```

Type-check:

```bash
bun run typecheck
```
