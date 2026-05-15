# Order Book

Order-book is a single Bun workspace that contains the backend, React frontend, participant scripts, SDK helpers, and Foundry contracts for the demo exchange. The app owns the order-book domain logic and uses `ffca` from `packages/ffca` as the runtime.

## Workspace Shape

Keep this as one workspace for now. The backend, frontend, scripts, SDK alias, and contracts are coupled to the same deployed `Exchange` address, chain ID, scheduler, and typed-data definitions, so splitting `contracts/` or `sdk/` into another workspace would add package boundaries without reducing configuration complexity.

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

For Monad testnet or a hosted deployment, start with:

```bash
cp .env.example.testnet .env
```

### Required Variables

| Variable | Used by | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | `bun dev`, `bun start`, `bun run deploy` | Funded deployer/backend wallet private key |
| `SCHEDULER_ADDRESS` | `bun run deploy` | EOA authorized to call `Exchange.execute()` |
| `DATABASE_URL` | `bun dev`, `bun start`, tests with Postgres | Postgres connection string |
| `BUN_PUBLIC_EXCHANGE_ADDRESS` | Backend, frontend, scripts | Deployed `Exchange` contract address |
| `BUN_PUBLIC_RPC_URL` | Backend, frontend, scripts, deploy | RPC endpoint. The backend accepts comma-separated failover URLs |
| `BUN_PUBLIC_CHAIN_ID` | Backend, frontend, scripts | Chain ID, for example `31337` for Anvil or `10143` for Monad testnet |
| `BUN_PUBLIC_RP_ID` | Frontend | WebAuthn relying party ID, usually the hostname |
| `BUN_PUBLIC_ORIGIN` | Frontend | Expected WebAuthn origin |
| `API_URL` | Scripts | Running order-book backend URL |

`BUN_PUBLIC_*` variables are intentionally public. `bunfig.toml` exposes them to browser code.

### Script Overrides

Participant scripts are run from `apps/order-book` and load the same `.env`. They require `API_URL` and reuse the `BUN_PUBLIC_*` chain settings above.

Set these only for one-off overrides:

| Variable | Description |
|---|---|
| `CHAIN_ID` | Overrides `BUN_PUBLIC_CHAIN_ID` for scripts |
| `EXCHANGE_ADDRESS` | Overrides `BUN_PUBLIC_EXCHANGE_ADDRESS` for scripts |
| `RPC_URL` | Overrides `BUN_PUBLIC_RPC_URL` for scripts |

Order-entry scripts also take command-specific variables such as `INSTRUMENT`, `SIDE`, `QUANTITY`, `PRICE`, and `INTERVAL`; see `scripts/README.md`.

## Local Dev Loop

Run these from separate terminals:

```bash
anvil --block-time 0.4
cd apps/order-book && cp .env.example.local .env && bun run deploy
cd apps/order-book && bun dev
```

Open <http://localhost:3000>. The same process serves the API, frontend, and FFCA runtime.

## Checks

From the repo root:

```bash
bun run lint
bun run typecheck
bun test
```
