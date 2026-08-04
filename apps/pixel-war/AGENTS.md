# AGENTS.md - pixel-war

A team pixel-canvas game built on `typewriter`. The app owns the canvas domain
logic, account/permission model, HTTP routes, frontend, and scripts. Do not change
`packages/typewriter` from this workspace.

## Layout

- `contracts/` — `PixelWar.sol` plus one library per mutation, deploy script, Foundry tests.
- `src/` — runtime config, canvas mirror, read-model queries, HTTP routes, SSE.
- `sdk/` — constants, palette, EIP-712 types, canvas math. Imported as `pixel-war-sdk` (a TS path alias, not a package).
- `frontend/` — React UI served by `src/index.ts` through Bun HTML imports.
- `scripts/` — `bot.ts` (autonomous player), `force-paint.ts` (force inclusion).

## Dev loop

Three terminals, from this directory:

```bash
anvil --block-time 0.4
cp .env.example.local .env && bun run deploy
bun dev
```

## Tests

```bash
forge test --root contracts
bun test                                   # needs Postgres + the native addon
bun run --filter pixel-war typecheck       # from the repo root
```

`bun test` needs two things the repo does not build for you: a reachable Postgres
(`TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/postgres`)
and the `typewriter-evm` native addon (`bun run --filter typewriter-evm build:debug`,
which needs a Rust toolchain and a C linker).

`forge test` skips `test_Paint_WithP256SessionKey` unless the RIP-7212 precompile
at `address(0x100)` exists, which it does under the Monad build of Foundry and
does not under upstream. Use the Monad build.

## The invariant this app exists to show

`sequencing.batchOrder` is `Initialize, Authorize, Revoke, AdvanceEpoch, Shield,
Paint, Bomb`, matching the `Mutation` enum declaration order. Within one batch,
every Shield runs before every Paint and every Paint before every Bomb, so
defense beats offense in a tie and bombs bury same-tick paints.

If you reorder the enum, reorder `PIXEL_WAR_BATCH_ORDER` in `sdk/index.ts` to
match, and check `scripts/force-paint.ts`'s `PAINT_TAG`, which is the enum's
numeric tag.

## Determinism rules to preserve

The whole game model is shaped by offchain/onchain determinism. Do not:

- write a value derived from `block.timestamp` or `block.number` into state
  (shields absorb hits instead of expiring for this reason);
- reach for randomness (team assignment picks the smallest team instead);
- move `state.epoch` from anything but the `AdvanceEpoch` mutation.

`block.timestamp` is fine for coarse checks with wide margins — signature
deadlines and key expiry — which is all it is used for.

## Gotchas

- A new mutation type touches `contracts/src/PixelWar.sol` (enum + `dispatch`),
  a new library in `contracts/src/`, `EIP712_TYPES` and `PIXEL_WAR_BATCH_ORDER`
  in `sdk/index.ts`, the table lists in `src/db-queries.ts`, `Canvas.touch` in
  `src/canvas.ts` if it moves pixels, and the frontend tool wiring.
- `state.canvas` is a `uint256[256]`. abitype cannot build a 256-element tuple
  type, so the generated proxy types that leaf opaquely and reads need the cast
  that `Canvas`/`canvasWords` already encapsulate. Runtime reads are fine.
- The canvas mirror never reimplements game rules: mutation events say which
  pixels *might* have changed, and the colors are always re-read from
  `typewriter.state`. Keep it that way — a second copy of the rules would drift.
- `contracts/src/PixelWar.sol.d.ts` is generated on `createTypewriter` startup.
  Commit it; do not hand-edit it.
- File-level Solidity constants cannot carry `///` natspec; use `//`.
