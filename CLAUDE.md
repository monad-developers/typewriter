# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

An on-chain order book demo on Monad testnet. A Bun monorepo (workspaces under `apps/*` and `packages/*`) split into:

- `apps/order-book-contracts` — Solidity (Foundry). `Exchange.sol` + `Account.sol`. Batched execution via a privileged scheduler, EIP-712 signed mutations, P-256/WebAuthn/secp256k1 keys with permission masks, parallel-nonce account model, and a force-exit queue so users can bypass the scheduler.
- `apps/order-book-backend` — Bun + React (HTML imports) + Postgres (Drizzle). Single `Bun.serve` process serves the API, the React UI, and runs the runtime that batches incoming signed mutations, sequences them (cancel → limit → market with uniform clearing for market orders), and submits to `Exchange.execute()`.
- `apps/order-book-scripts` — TS scripts emulating market participants (limit, market, market-maker, retail, arbitrage, gas). Drives the backend's HTTP API; uses `order-book-backend` workspace import for its SDK helpers.
- `packages/order-book-sdk` — shared types/constants (instruments, assets, EIP-712 type defs, permission bits, `TokenAmount`/lot math, exchange ABI).
- `apps/token-contracts` and `apps/token-frontend` — earlier ERC-20 transfer demo, kept for reference. Not the focus.

The backend is non-custodial: it can't forge mutations (every mutation is user-signed), can't reorder within a batch (sequencing rules are enforced onchain), and can be bypassed via `forceInclude` if it stalls.

## Common commands

From the repo root:

```bash
bun install
bun run lint        # biome check + per-workspace lint (forge fmt for contracts)
bun run typecheck   # tsc --noEmit per workspace
bun run build       # per-workspace builds (forge build for contracts)
```

Local dev requires three terminals:

```bash
anvil --block-time 0.4                                                     # 1. local chain
cd apps/order-book-contracts && cp .env.example.local .env && bun run deploy   # 2. deploy Exchange
cd apps/order-book-backend   && cp .env.example.local .env && bun dev          # 3. backend + UI on :3000
```

Backend tests (Bun's built-in runner, with Postgres + ephemeral Anvil via `prool`):

```bash
cd apps/order-book-backend
bun test                                          # all tests
bun test runtime                                  # filename filter
bun test -t "fills a market order"                # name filter
TEST_DATABASE_URL=postgres://... bun test         # override DB
```

Contract tests (Foundry):

```bash
cd apps/order-book-contracts
forge test
forge test --match-test testFillsAtUniformPrice
forge test -vvv                                   # traces on failure
```

Foundry **nightly** is required (`foundryup --install nightly`) — the Exchange uses the P-256 precompile at `address(0x100)` (RIP-7212), which stable Foundry (1.5.1) does not include. Both `forge test` and `anvil` need the nightly build.

Scripts (run from `apps/order-book-scripts/`):

```bash
bun scripts/add-instrument.ts                                                   # run first
PRICE=2400 SIDE=buy QUANTITY=1 INSTRUMENT=GOLD/USD bun scripts/limit-order.ts
SIDE=buy QUANTITY=0.5 INSTRUMENT=GOLD/USD bun scripts/market-order.ts
```

## Architecture notes worth knowing up front

**Per-deployment Postgres schemas.** Each `(chainId, exchangeAddress)` pair gets its own Postgres schema named `d_<n>` (serial id from the public `deployments` table). At startup `src/migrate.ts` takes a `pg_advisory_lock` on `(chainId, address)`, runs the files in `apps/order-book-backend/drizzle/` against the public schema (those files only create the `deployments` registry table), then either looks up an existing row or creates a new `d_<n>` schema and materializes the app tables inside it. The writer/reader DB clients then `SET search_path = d_<n>, public`. Tests drop all `d_*` schemas in `beforeAll`. One backend process owns exactly one deployment schema.

The app tables (`mutations`, `bundles`, `accounts`, …) are **not** versioned migrations — they're generated at runtime from `app-schema.ts` via `drizzle-kit/api`'s `generateMigration(empty, target)` the first time a deployment is seen. There is no migration history for app tables, so schema changes to `app-schema.ts` require dropping the affected `d_<n>` schema (or all of them) and letting startup re-create it. Files in `drizzle/` are only for the `deployments` registry.

**Runtime is `effect`-based.** `src/runtime.ts` is a long-running Effect program with a queue of mutations, batch-window scheduling (default 50 ms), bundle building, and EIP-712 + raw-signed transaction submission via viem's `sendRawTransactionSync`. The HTTP routes in `src/index.ts` push into `handle.execute(...)` and stream events out via SSE (`/api/events/{blocks,bundles,mutations}`).

**Mutation lifecycle.** Each mutation is one of: `initialize`, `authorize`, `revoke`, `addInstrument`, `deposit`, `withdrawal`, `limitOrder`, `marketOrder`, `closeOrder`. Statuses progress `pending → accepted → proposed → voted → finalized → verified` (the UI surfaces these). The central `mutations` table joins to one of nine type-specific tables (`limit_orders`, `market_orders`, etc.) plus a `fills` table for market orders — see `loadMutationsByIds` in `src/index.ts` for the join pattern.

**Auth model.** Accounts are 32-byte ids (not EOAs). Each holds a list of keys (root + delegates) with permission masks and expiries. Frontend uses WebAuthn passkeys at sign-in and ephemeral P-256 session keys (stored in IndexedDB via `lib/sessionKey*.ts`) for order placement. EIP-712 typed-data signing is in `lib/eip712.ts`; types live in `packages/order-book-sdk` (`EIP712_TYPES`). Nonces are parallel — keyed by `(account, keyIndex)` so concurrent mutations don't serialize.

**Frontend.** `Bun.serve` + HTML imports, no Vite. Entry is `src/frontend/index.html` mounted at `/*`. React 19, TanStack Query, Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`). The `/about` page is the architectural walkthrough — message lifecycle, force-exit, gas figures.

**Lint/format.** Biome 2.x (`biome.json`) for JS/TS/CSS; `forge fmt` for Solidity. Biome ignores `apps/token-contracts/broadcast/`. `noNonNullAssertion` is off — `!` is allowed.

## Bun-first conventions

This is a Bun project; default to Bun APIs over Node/npm equivalents.

- Run files with `bun <file>`, not `node` or `ts-node`.
- `bun install` / `bun run <script>` / `bunx <pkg>` instead of npm/yarn/pnpm/npx.
- `bun test` — not jest/vitest. Tests use `import { test, expect } from "bun:test"`.
- `bun build` — not webpack/esbuild.
- Don't add `dotenv`; Bun loads `.env` automatically.
- Server: `Bun.serve()` (already in use). Don't add `express`.
- DB: `Bun.SQL` for Postgres (already wired into Drizzle). Don't add `pg` or `postgres.js`.
- Files: prefer `Bun.file` over `node:fs`. Shell: `Bun.$` over `execa`.
- WebSockets: built-in `WebSocket`, no `ws`.
- Frontend: HTML imports with `Bun.serve()` (no Vite). `<script type="module" src="./frontend.tsx">` and `import './index.css'` work directly.
