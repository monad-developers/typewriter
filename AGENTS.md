# AGENTS.md

Repo-wide guidance. Per-app specifics live in each workspace's own `AGENTS.md` / `README.md`.

## Layout

A Bun monorepo. Apps live under `apps/*`; reusable framework code lives under `packages/*`. The current state is one app (`order-book-*`) plus a framework package (`typewriter`) being extracted from it.

## Docs

`README.md` and `packages/typewriter/README.md` are copies of each other. Keep them in sync when editing either file.

## Common commands

Run from the repo root:

```bash
bun install
bun run lint        # biome + per-workspace lint
bun run typecheck   # tsc --noEmit per workspace
bun run build       # per-workspace builds
```

The root `typecheck` script is intentionally sequential instead of
`bun run --filter '*' typecheck`: Bun can run filtered workspace scripts in
parallel, which makes dependent workspaces typecheck `storage-layout` at the
same time and can create enough TypeScript memory pressure to crash small remote
instances. Keep it one workspace at a time unless the type setup changes to use
project references or declaration boundaries.

## Before declaring work complete

Run all three checks at the repo root before saying a task is done — not just one:

- `bun run lint` — Biome formatter + linter (catches formatting drift, unused vars, style violations)
- `bun run typecheck` — `tsc --noEmit` per workspace
- `bun run test` — per-workspace test scripts

For type-only changes (`.d.ts`, type tests, or purely compile-time inference
work), `bun run test` is not required when `bun run lint` and
`bun run typecheck` pass. Say explicitly that tests were skipped because the
change is type-only.

`bun run typecheck` alone is not sufficient: Biome catches things TS doesn't (formatting, unused imports under different rules), and TS catches things Biome doesn't (`noUnusedLocals`, type narrowing). Pre-existing failures unrelated to your changes are fine to flag and skip past, but don't introduce new ones.

## Bun-first conventions

This is a Bun project; default to Bun APIs over Node/npm equivalents.

- Run files with `bun <file>`, not `node` or `ts-node`.
- `bun install` / `bun run <script>` / `bunx <pkg>` instead of npm/yarn/pnpm/npx.
- `bun test` — not jest/vitest. Tests use `import { test, expect } from "bun:test"`.
- `bun build` — not webpack/esbuild.
- Don't add `dotenv`; Bun loads `.env` automatically.
- Server: `Bun.serve()`. Don't add `express`.
- DB: `Bun.SQL` for Postgres (wired into Drizzle). Don't add `pg` or `postgres.js`.
- Files: prefer `Bun.file` over `node:fs`. Shell: `Bun.$` over `execa`.
- WebSockets: built-in `WebSocket`, no `ws`.
- Frontend: HTML imports with `Bun.serve()` (no Vite). `<script type="module" src="./frontend.tsx">` and `import './index.css'` work directly.

## Crypto libraries

Prefer **ox** over **viem** wherever both work. ox is lower-level and lighter-weight — primitives only (`Hex`, `Address`, `Secp256k1`, `Signature`, `AbiParameters`, etc.). viem stays where an actual RPC client is needed (`createPublicClient`, `createWalletClient`, `sendRawTransactionSync`). New framework or SDK code should target ox; viem belongs at the app's runtime edge.

## Shared dependency versions

Cross-workspace dependency versions live in the root `package.json`'s `"catalog"` field. Workspaces reference them as `"<pkg>": "catalog:"`. Add a package to the catalog when it's used in 2+ workspaces; don't move things in speculatively. `@types/bun` is declared once at the root only — it hoists to the root `node_modules` and TS finds it from any workspace.

## Adding new dependencies

Don't add a new dependency unless explicitly directed. Before reaching for `bun add`, check whether the runtime, Bun's stdlib, or an already-installed package covers the need (e.g. Bun ships `expectTypeOf` in `bun:test`, so `expect-type` isn't needed). If a new dependency seems warranted, ask first.

Pin exact versions for security — no `^` or `~` ranges. `bun add` defaults to a caret range; strip it after install. The lockfile gives reproducibility, but exact versions in `package.json` make supply-chain review easier and prevent silent minor-version drift on fresh installs that race the lockfile.

## Tests

Run workspace-local test suites from that workspace's directory, or through the
workspace script (`bun run --filter <workspace> test`). Do **not** run tests from
the repo root by passing a workspace path (for example, avoid
`bun test packages/typewriter`): Bun may skip the workspace's local `bunfig.toml`, so
preloaded setup hooks can run with the wrong lifecycle.

For the whole repo, run `bun run test` from the root, not raw `bun test`. The
root script dispatches each workspace's own `test` script, preserving workspace
timeouts and preload/setup behavior; raw root `bun test` discovers tests directly
and can produce misleading setup failures.

Prefer `.toMatchInlineSnapshot()` over hand-written equality assertions when the expected value is non-trivial. Snapshots are easier to read, easier to update, and surface unintended diffs faster than `.toEqual({...})` against a hand-maintained literal.

When a suite-wide test run reports many failures, especially with `beforeEach`/`afterEach` timeouts or "Unhandled error between tests", run a single test in isolation to see the actual error. Cascading setup failures hide the root cause — `bun test -t "name fragment"` (or `bun test path/to/file.test.ts`) cuts through the noise and surfaces the real exception in the first failing test.

If a suite-wide test run hits two timeout failures, cancel the process early; the rest are likely to timeout for the same reason.

## Lint / format

Biome 2.x (`biome.json`) for JS/TS/CSS; `forge fmt` for Solidity. `noNonNullAssertion` is off — `!` is allowed.

## Foundry

Use the Monad version of Foundry for all `forge` and `anvil` commands. The contracts and tests rely on Monad-specific gas rules and Monad/RIP-7212 behavior, including the P-256 precompile at `address(0x100)`, so upstream stable Foundry is not sufficient.

Prefer specific validity checks over truthy/falsy shortcuts: `if (mutation === undefined)` over `if (!mutation)`, `if (xs.length === 0)` over `if (!xs.length)`. `!x` collapses undefined / null / 0 / "" / false / NaN into one branch — for domain values that could legitimately be `0` or `""` it silently wrong-paths, and even when those cases can't occur the explicit form makes the intended invariant readable. Reach for `!x` only on actual booleans.

## Gotcha: `bun install` blocked by `minimum-release-age`

The repo's `bunfig.toml` enforces `minimumReleaseAge = 2419200` (28 days) as a supply-chain defense — bun refuses any version younger than that. If `bun.lock` or a `package.json` constraint pins a too-recent version, install fails with "No version matching X found / blocked by minimum-release-age". Fix: `bun remove <pkg> && bun add <pkg>` — `bun add` walks back to find a version that satisfies the constraint *and* clears the age gate.

## Gotcha: `bun.lock` merge conflicts

Don't hand-resolve `bun.lock` during a merge or rebase. The file is generated, internally consistent in ways that aren't obvious from the diff, and `<<<<<<< / >>>>>>>` markers will leave it parse-broken. Resolve the `package.json` conflicts manually, then run `bun install` — bun will regenerate `bun.lock` from the merged `package.json` state. If a leftover conflict marker keeps bun from parsing the file at all, `rm bun.lock && bun install` to rebuild from scratch.

## Available CLIs

Two authenticated CLIs are expected. Validate before relying on them; if a check fails, **stop and ask the user to fix it** rather than working around it.

- **`gh`** — GitHub CLI. Repo is `monad-exp/order-book`. Validate with `gh auth status` (needs `repo`, `workflow`, `read:org` scopes). If not logged in, ask the user to install (`brew install gh` / [cli.github.com](https://cli.github.com/)) and run `gh auth login`. If authed but lacking org access, ask for a `monad-exp` invite.
- **`railway`** — Railway CLI. Repo should be linked to the `order book` project (`production`) under the `MF Experimental` team. Link config lives in `~/.railway/config.json`. **No default service is set** — always pass `--service <name>` (e.g. `railway logs --service backend`). Deploys go through the Railway GitHub App on pushes to `main`, so prefer read-only commands. Validate with `railway whoami` and `railway status`. If `railway status` reports no linked project, ask the user to run `railway link` from the repo root (interactive). If they can't see the project, they likely need an invite to the `MF Experimental` team.
