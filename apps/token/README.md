# Token

Minimal token app built on `typewriter` with native credential-based accounts
and FIFO sequencing. The browser creates a P-256 key with WebCrypto, stores it
in IndexedDB, and uses `typewriter/client` to authorize account creation, mint,
and transfer mutations.

## Getting Started

1. Install dependencies from the repo root with `bun install`.
2. Copy the example env file and fill in the values you need:

```bash
cp .env.example .env
```

3. Make sure you have a Postgres database and an RPC endpoint available.
4. Build the contract artifacts:

```bash
bun run contracts:build
```

5. Deploy the token contract:

```bash
bun run deploy
```

If you deploy to a chain where the address differs from the example value (non-anvil chain), update `TOKEN_ADDRESS` in `.env` before starting the app.

6. Start the app:

```bash
bun run dev
```

7. Open the app at `http://localhost:3000`.

## Optional: Start Anvil

If you want a local Monad chain for deployment and manual testing, start Anvil in a separate terminal:

```bash
anvil --network monad --block-time 0.4
```

The latest Foundry release includes Monad support, so no separate category-labs Foundry build is required. The example `.env` values are set up for that local node.

## .env

`apps/token/.env.example` is the source of truth for local config. Bun loads `.env` automatically for the app, and the Foundry deploy script sources it explicitly.

### Runtime

| Variable | Used by | Description |
|---|---|---|
| `RPC_URL` | App runtime, deploy script | RPC endpoint for the token app and deployment command |
| `DATABASE_URL` | App runtime, tests | Postgres connection string used by Typewriter |
| `CHAIN_ID` | App runtime | Chain ID included in the Typewriter manifest and authorization domain |
| `TOKEN_ADDRESS` | App runtime | Deployed token contract address |
| `PRIVATE_KEY` | App runtime, deploy script | Private key used by the scheduler account and Foundry broadcast |

Tests use `DATABASE_URL` for the administrative connection. Each test creates
and removes its own temporary Postgres database.
