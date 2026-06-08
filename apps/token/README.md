# Token

Minimal token app built on `ffca` with FIFO sequencing.

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

If you want a local chain for deployment and manual testing, start the Monad build of Anvil in a separate terminal:

```bash
anvil --monad --block-time 0.4
```

The example `.env` values are set up for that local node. Use `anvil --monad`, not the upstream stable Anvil binary.

## .env

`apps/token/.env.example` is the source of truth for local config. Bun loads `.env` automatically for the app, and the Foundry deploy script sources it explicitly.

### Runtime

| Variable | Used by | Description |
|---|---|---|
| `RPC_URL` | App runtime, deploy script | RPC endpoint for the token app and deployment command |
| `DATABASE_URL` | App runtime, tests | Postgres connection string used by FFCA |
| `CHAIN_ID` | App runtime | Chain ID used for typed-data signing |
| `TOKEN_ADDRESS` | App runtime | Deployed token contract address |
| `PRIVATE_KEY` | App runtime, deploy script | Private key used by the scheduler account and Foundry broadcast |

### Test-only

`bun run test` also honors `TEST_DATABASE_URL` if you want to point the test suite at a separate Postgres instance. If it is unset, the tests default to `postgres://postgres:postgres@localhost:5432/postgres`.
