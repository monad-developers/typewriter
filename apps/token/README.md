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

## .env

`apps/token/.env.example` is the source of truth for local config. Bun loads `.env` automatically for the app, and the Foundry deploy script sources it explicitly.

### Runtime

| Variable | Used by | Description |
|---|---|---|
| `DATABASE_URL` | App runtime | Postgres connection string used by Typewriter |
