# CLAUDE.md — order-book-backend

Bun + React (HTML imports) + Postgres (Drizzle). Single `Bun.serve` process serves the API, the React UI, and runs the runtime that batches incoming signed mutations, sequences them (cancel → limit → market with uniform clearing for market orders), and submits to `Exchange.execute()`.

## Dev loop

Three terminals:

```bash
anvil --block-time 0.4                                                   # 1. local chain
cd apps/order-book-contracts && cp .env.example.local .env && bun run deploy   # 2. deploy Exchange
cd apps/order-book-backend   && cp .env.example.local .env && bun dev          # 3. backend + UI on :3000
```

## Tests

Bun's built-in runner, with Postgres + ephemeral Anvil via `prool`:

```bash
bun test                                          # all tests
bun test runtime                                  # filename filter
bun test -t "fills a market order"                # name filter
TEST_DATABASE_URL=postgres://... bun test         # override DB
```

## Architecture

**Per-deployment Postgres schemas.** Each `(chainId, exchangeAddress)` pair gets its own Postgres schema named `d_<n>` (serial id from the public `deployments` table). At startup `src/migrate.ts` takes a `pg_advisory_lock` on `(chainId, address)`, runs the files in `drizzle/` against the public schema (those files only create the `deployments` registry table), then either looks up an existing row or creates a new `d_<n>` schema and materializes the app tables inside it. The writer/reader DB clients then `SET search_path = d_<n>, public`. Tests drop all `d_*` schemas in `beforeAll`. One backend process owns exactly one deployment schema.

The app tables (`mutations`, `bundles`, `accounts`, …) are **not** versioned migrations — they're generated at runtime from `app-schema.ts` via `drizzle-kit/api`'s `generateMigration(empty, target)` the first time a deployment is seen. There is no migration history for app tables, so schema changes to `app-schema.ts` require dropping the affected `d_<n>` schema (or all of them) and letting startup re-create it. Files in `drizzle/` are only for the `deployments` registry.

**Runtime is `effect`-based.** `src/runtime.ts` is a long-running Effect program with a queue of mutations, batch-window scheduling (default 50 ms), bundle building, and EIP-712 + raw-signed transaction submission via viem's `sendRawTransactionSync`. The HTTP routes in `src/index.ts` push into `handle.execute(...)` and stream events out via SSE (`/api/events/{blocks,bundles,mutations}`).

**Mutation lifecycle.** Each mutation is one of: `initialize`, `authorize`, `revoke`, `addInstrument`, `deposit`, `withdrawal`, `limitOrder`, `marketOrder`, `closeOrder`. Statuses progress `pending → accepted → proposed → voted → finalized → verified` (the UI surfaces these). The central `mutations` table joins to one of nine type-specific tables (`limit_orders`, `market_orders`, etc.) plus a `fills` table for market orders — see `loadMutationsByIds` in `src/index.ts` for the join pattern.

**Auth model.** Accounts are 32-byte ids (not EOAs). Each holds a list of keys (root + delegates) with permission masks and expiries. Frontend uses WebAuthn passkeys at sign-in and ephemeral P-256 session keys (stored in IndexedDB via `lib/sessionKey*.ts`) for order placement. EIP-712 typed-data signing is in `lib/eip712.ts`; types live in `apps/order-book-sdk` (`EIP712_TYPES`). Nonces are parallel — keyed by `(account, keyIndex)` so concurrent mutations don't serialize.

**Frontend.** `Bun.serve` + HTML imports, no Vite. Entry is `src/frontend/index.html` mounted at `/*`. React 19, TanStack Query, Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`). The `/about` page is the architectural walkthrough — message lifecycle, force-exit, gas figures.

## Gotchas

- **App-table schema changes don't auto-apply.** Tables under `d_<n>` are generated once when a deployment is first seen. After editing `app-schema.ts`, drop the schema (or the DB) and restart — there is no `drizzle-kit generate` step for app tables.
- **A new mutation type touches many files.** `Exchange.sol`, EIP-712 types in `apps/order-book-sdk`, `app-schema.ts` (the central `mutations` row + a type-specific table), `loadMutationsByIds` in `src/index.ts`, runtime sequencing in `src/runtime.ts`, and the frontend builder. No single extension point.
- **`/about` is the canonical architecture walkthrough.** When writing user-facing prose about the message lifecycle, force-exit, or gas figures, edit that page rather than starting a parallel doc.
