# AGENTS.md - order-book

Order book implementation using `typewriter` as the runtime. The app owns order-book domain logic, persistence hooks, HTTP routes, frontend serving, scripts, SDK helpers, and signature/account verification. Do not change `packages/typewriter` from this workspace.

## Layout

- `src/` — app state model, mutation config, HTTP routes, persistence hooks, constants, signature helpers.
- `frontend/` — React UI served by `src/index.ts` with Bun HTML imports.
- `sdk/` — shared order-book constants, EIP-712 types, ABI, and math helpers. It is folded into this package; the `order-book-sdk` import is a TS path alias.
- `scripts/` — participant scripts that drive the app HTTP API.
- `contracts/` — Typewriter-backed `Exchange.sol`, deploy script, contract docs, and active Foundry tests.
- `docs/` — migration notes and app-specific context not covered by `packages/typewriter` docs.

## Dev Loop

Three terminals:

```bash
anvil --block-time 0.4
cd apps/order-book && cp .env.example.local .env && bun run deploy
cd apps/order-book && cp .env.example.local .env && bun dev
```

Open <http://localhost:3000>. The same process serves the API, frontend, and Typewriter runtime.

## Tests

Run from `apps/order-book` unless noted:

```bash
bun test
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun test
forge test --root contracts
forge test --root contracts --match-test testFillsAtUniformPrice
```

From the repo root, prefer workspace scripts:

```bash
bun run --filter order-book typecheck
bun run --filter order-book test
```

## App Model

Accounts are 32-byte ids, not EOAs. Each account holds root/delegate keys with permission masks and expiries. Frontend sign-in uses WebAuthn passkeys and ephemeral P-256 session keys stored in IndexedDB via `frontend/lib/sessionKey*.ts`. EIP-712 typed-data signing is in `frontend/lib/eip712.ts`; mutation types live in `sdk/index.ts` as `EIP712_TYPES`. Nonces are parallel and keyed by `(account, keyIndex)` so concurrent mutations do not serialize.

Mutation types are `initialize`, `authorize`, `revoke`, `addInstrument`, `deposit`, `withdrawal`, `limitOrder`, `marketOrder`, and `closeOrder`. Contract/batch sequencing is cancel -> limit -> market with uniform clearing for market orders.

Frontend uses `Bun.serve` + HTML imports, no Vite. Entry is `frontend/index.html` mounted at `/*`. React 19, TanStack Query, Tailwind v4 via `bun-plugin-tailwind` in `bunfig.toml`. The `/about` page is the canonical architecture walkthrough; edit it rather than creating parallel user-facing prose about lifecycle, force-exit, or gas figures.

## Gotchas

- A new mutation type touches `contracts/src/Exchange.sol`, EIP-712 types in `sdk/index.ts`, mutation config in `src/app.ts` (`order_book_mutations`), HTTP/read model wiring in `src/index.ts`, and frontend builders/renderers. Typewriter generates the per-mutation persistence schema from `order_book_mutations`; the app accesses it through `app.schema`.
- Keep contract changes in `contracts/src` source-compatible with active tests in `contracts/test` where possible.
- Do not reintroduce app-specific code into `packages/typewriter`.
