# Order Book

Order-book is a single Bun workspace that contains the backend, React frontend, participant scripts, SDK helpers, and Foundry contracts for the demo order book. The app owns the order-book domain logic and uses `typewriter` from `packages/typewriter` as the runtime.

## Workspace Shape

Keep this as one workspace for now. The backend, frontend, scripts, SDK alias, and contracts are coupled to the same deployed `OrderBook` address, chain ID, scheduler, and typed-data definitions, so splitting `contracts/` or `sdk/` into another workspace would add package boundaries without reducing configuration complexity.

Reconsider a split only if one of these becomes true:

- The SDK needs to be published or consumed independently of the app.
- Contracts need independent versioning, releases, or CI from the app.
- Another app starts importing order-book domain code directly.

## Environment

Use one app-level `.env` file in `apps/order-book`. Nested `contracts/` and `scripts/` env examples are intentionally avoided so new contributors have one place to look.

Start local development with:

```bash
cp .env.example.local .env
```

`bun dev` runs Typewriter in dev mode: it starts a local Anvil, deploys `OrderBook` with Anvil account #0 as the scheduler, starts from an empty database schema, and seeds the book (every instrument, with limit orders at 1, 5, 10, and 25bp around a fixed price). Every start is a new chain.

`bun start` runs against a deployed `OrderBook`. For Monad testnet or a hosted deployment, start with:

```bash
cp .env.example.testnet .env
bun run deploy
bun scripts/seed.ts # with the backend running
```

### Required Variables

| Variable | Used by | Description |
|---|---|---|
| `DATABASE_URL` | `bun dev`, `bun start` | Postgres connection string |
| `PRIVATE_KEY` | `bun start`, `bun run deploy` | Funded deployer/backend wallet private key |
| `ORDER_BOOK_ADDRESS` | `bun start` | Deployed `OrderBook` contract address |
| `RPC_URL` | `bun start`, `bun run deploy` | RPC endpoint. The backend accepts comma-separated failover URLs |
| `CHAIN_ID` | `bun start` | Chain ID, for example `10143` for Monad testnet |
| `BUN_PUBLIC_RP_ID` | Frontend | WebAuthn relying party ID, usually the hostname |
| `BUN_PUBLIC_ORIGIN` | Frontend | Expected WebAuthn origin |
| `API_URL` | Scripts | Running order-book backend URL |

`BUN_PUBLIC_*` variables are only used for browser-facing WebAuthn settings. `bunfig.toml` exposes them to browser code.

Participant scripts are run from `apps/order-book` and load the same `.env`. They read the deployment from the backend's `/api/manifest` at `API_URL`, and take command-specific variables such as `INSTRUMENT`, `SIDE`, `QUANTITY`, `PRICE`, and `INTERVAL`; see `scripts/README.md`.

## Local Dev Loop

```bash
cd apps/order-book && cp .env.example.local .env && bun dev
```

Open <http://localhost:3000>. The same process serves the API, frontend, and Typewriter runtime. Restart it to pick up server changes.

## Checks

From the repo root:

```bash
bun run lint
bun run typecheck
```
