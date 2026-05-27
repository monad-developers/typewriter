# AGENTS.md - token

Minimal token app using `ffca` with FIFO sequencing. Keep app-specific contract, runtime config, HTTP routes, and tests inside `apps/token`; do not move token concerns into `packages/ffca`.

## Commands

Run from `apps/token`:

```bash
bun run test
bun run typecheck
bun run contracts:build
forge test --root contracts
```

Use `bun run test`, not `bun test`, so Bun loads `bunfig.toml` and the Anvil setup preload.
