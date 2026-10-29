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

Without `RPC_URL`, `bun dev` runs Typewriter in dev mode: it starts a local Anvil, deploys `OrderBook` with Anvil account #0 as the scheduler, and starts from an empty database schema. Leave `PRIVATE_KEY`, `ORDER_BOOK_ADDRESS`, and `CHAIN_ID` unset then; Typewriter refuses to start in dev mode with any of them set. Participant scripts read the deployment from the running backend at `API_URL`.

For Monad testnet or a hosted deployment, start with:

```bash
cp .env.example.testnet .env
```

### Required Variables

| Variable | Used by | Description |
|---|---|---|
| `PRIVATE_KEY` | `bun start`, `bun run deploy`, `bun dev` with `RPC_URL` | Funded deployer/backend wallet private key |
| `DATABASE_URL` | `bun dev`, `bun start` | Postgres connection string |
| `ORDER_BOOK_ADDRESS` | Backend, scripts | Deployed `OrderBook` contract address. Only with `RPC_URL` |
| `RPC_URL` | Backend, scripts, deploy | RPC endpoint. The backend accepts comma-separated failover URLs. Unset in development to run on a local Anvil |
| `CHAIN_ID` | Backend, scripts | Chain ID, for example `10143` for Monad testnet. Only with `RPC_URL` |
| `BUN_PUBLIC_RP_ID` | Frontend | WebAuthn relying party ID, usually the hostname |
| `BUN_PUBLIC_ORIGIN` | Frontend | Expected WebAuthn origin |
| `API_URL` | Scripts | Running order-book backend URL |

`BUN_PUBLIC_*` variables are only used for browser-facing WebAuthn settings. `bunfig.toml` exposes them to browser code.

### Script Overrides

Participant scripts are run from `apps/order-book` and load the same `.env`. They require `API_URL`, and read the chain ID and order book address from the backend's `/api/manifest` unless `CHAIN_ID` and `ORDER_BOOK_ADDRESS` are set.

Set these only for one-off overrides:

| Variable | Description |
|---|---|
| `CHAIN_ID` | One-off override for scripts |
| `ORDER_BOOK_ADDRESS` | One-off override for scripts |
| `RPC_URL` | One-off override for scripts |

Order-entry scripts also take command-specific variables such as `INSTRUMENT`, `SIDE`, `QUANTITY`, `PRICE`, and `INTERVAL`; see `scripts/README.md`.

## Local Dev Loop

```bash
cd apps/order-book && cp .env.example.local .env && bun dev
```

Open <http://localhost:3000>. The same process serves the API, frontend, and Typewriter runtime.

## Checks

From the repo root:

```bash
bun run lint
bun run typecheck
```
