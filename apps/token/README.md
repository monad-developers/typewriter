# Token

Minimal token app built on `typewriter` with native credential-based accounts
and FIFO sequencing. The browser creates a P-256 key with WebCrypto, stores it
in IndexedDB, and uses `typewriter/client` to authorize account creation, mint,
and transfer mutations.

## Getting Started

1. Install dependencies from the repo root with `bun install`.
2. Install [Foundry](https://getfoundry.sh); the app uses `anvil` and `forge`.
3. Copy the example env file, and point `DATABASE_URL` at a Postgres database:

```bash
cp .env.example .env
```

4. Start the app:

```bash
bun run dev
```

5. Open the app at `http://localhost:3000`.

Without `RPC_URL`, the app runs Typewriter in dev mode: it starts a local Anvil, deploys the token with Anvil's first account as the scheduler, and starts from an empty database schema. Every start is a fresh chain.

## Running Against a Deployed Token

1. Set `RPC_URL`, `CHAIN_ID`, `TOKEN_ADDRESS`, and `PRIVATE_KEY` in `.env`.
2. Deploy the token contract:

```bash
bun run deploy
```

If the deployed address differs from the example value, update `TOKEN_ADDRESS` in `.env`.

3. Start the app with `bun run dev`, or `bun start` in production.

## .env

`apps/token/.env.example` is the source of truth for local config. Bun loads `.env` automatically for the app, and the Foundry deploy script sources it explicitly.

### Runtime

| Variable | Used by | Description |
|---|---|---|
| `RPC_URL` | App runtime, deploy script | RPC endpoint for the token app and deployment command. Unset in development to run on a local Anvil |
| `DATABASE_URL` | App runtime | Postgres connection string used by Typewriter |
| `CHAIN_ID` | App runtime | Chain ID included in the Typewriter manifest and authorization domain. Only with `RPC_URL` |
| `TOKEN_ADDRESS` | App runtime | Deployed token contract address. Only with `RPC_URL` |
| `PRIVATE_KEY` | App runtime, deploy script | Private key used by the scheduler account and Foundry broadcast. Only with `RPC_URL` |
