# napi-rs ffca-evm Follow-Up Plan

Status: productionized on `napi-ffca-evm-poc`. The native addon is the only
transport; the stdio sidecar binary has been removed.

## POC Result

The POC keeps the existing TypeScript `createEVM()` API and replaces the stdio
sidecar transport with an in-process napi-rs class. The native class owns the
existing Rust `EvmHarness` and exposes one method:

```ts
native.call(JSON.stringify(request)) -> JSON.stringify(response)
```

This intentionally preserves the existing JSON request/response protocol so the
benchmark isolates the process-boundary cost without rewriting behavior.

Benchmark used: `packages/ffca-evm/test/execute.benchmark.ts` with release native
addon (`FFCA_EVM_PROFILE=release`).

Observed throughput:

- sidecar baseline from prior run: about 4.2k calls/s
- napi-rs POC: about 83k-85k calls/s
- improvement: about 20x on the microbenchmark

Conclusion: napi-rs is worth pursuing. Even the intentionally conservative POC,
which still pays JSON encode/decode cost, materially beats the stdio sidecar.

## Done

1. Split the Rust code into real modules. `include!("main.rs")` is gone:

   - `src/harness.rs`: wire types, `EvmHarness`, parsing/formatting helpers,
     dispatch logic, and the infallible `dispatch_json` entry point.
   - `src/lib.rs`: napi-rs exports only (`mod harness;` + the `NativeEvm` class).

   The blanket `#![allow(dead_code)]` is removed; the crate is clippy-clean
   under `-D warnings`.

2. Removed the stdio binary entirely. `src/main.rs` and the `[[bin]]` target
   are deleted; the native addon is the single transport.

4. Cross-platform build via `@napi-rs/cli`. `napi build` stages the addon at
   `native/ffca-evm.node` on any platform (no hand-rolled `.so`/`.dylib` copy).
   Tests and production load the same artifact and code path; `bun run build`
   compiles release, `bun run build:debug` (used by `bun run test`) compiles
   debug. Profile only changes optimization, not behavior.

## Remaining Work

3. Replace JSON-at-the-native-boundary with typed napi inputs if needed.

   The POC result suggests the process boundary dominates this benchmark, not
   JSON. Keep JSON until a follow-up benchmark shows it matters. If it does,
   expose typed methods such as `init`, `execute`, `simulate`, and `readStorage`
   instead of one `call(requestJson)` method.

4. Re-run the ffca batch benchmark after the refactor.

   The microbenchmark shows the native boundary is much faster. The next useful
   system-level check is `packages/ffca/test/harness.benchmark.ts` to measure how
   much of that survives with real mutation preparation and DB persistence. To
   benchmark the release addon:

   ```bash
   bun run --filter ffca-evm build
   cd packages/ffca-evm && bun test ./test/execute.benchmark.ts
   ```

## Validation

Commands run successfully in the worktree:

```bash
bun run --filter ffca-evm test
bun run --filter ffca-evm typecheck
bun run --filter ffca-evm lint
bun run lint
bun run typecheck
DATABASE_URL=postgres://postgres@localhost:5432/postgres bun run test
```
