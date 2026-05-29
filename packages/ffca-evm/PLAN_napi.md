# napi-rs ffca-evm Follow-Up Plan

Status: proof of concept implemented in `napi-ffca-evm-poc`.

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

## Remaining Work

1. Split the Rust code into a real library module.

   Today the POC uses `include!("main.rs")` from `src/lib.rs` to minimize the
   change. Replace this with a proper shared module, for example:

   - `src/harness.rs`: wire types, `EvmHarness`, parsing/formatting helpers,
     and dispatch logic
   - `src/main.rs`: stdio loop only
   - `src/lib.rs`: napi-rs exports only

2. Decide whether the stdio binary remains supported.

   Keeping it for one transition period is useful for fallback and comparison,
   but the TS wrapper should have one default path. If the native path stays,
   the binary can become a dev/debug tool instead of the production transport.

3. Replace JSON-at-the-native-boundary with typed napi inputs if needed.

   The POC result suggests the process boundary dominates this benchmark, not
   JSON. Keep JSON until a follow-up benchmark shows it matters. If it does,
   expose typed methods such as `init`, `execute`, `simulate`, and `readStorage`
   instead of one `call(requestJson)` method.

4. Make native artifact naming cross-platform.

   Current scripts copy Linux `libffca_evm.so` to `ffca_evm.node`. Production
   scripts should handle macOS and Linux explicitly, or use the standard napi-rs
   build tooling if packaging becomes necessary.

5. Define build/package expectations.

   Current commands:

   ```bash
   bun run --filter ffca-evm build:napi:debug
   bun run --filter ffca-evm build
   ```

   Release benchmark command:

   ```bash
   cd packages/ffca-evm
   FFCA_EVM_PROFILE=release bun test ./test/execute.benchmark.ts
   ```

   Decide whether `build` should always produce both the sidecar binary and the
   native addon, and whether tests should require the debug addon to exist or
   build it automatically as they do in the POC.

6. Add an explicit transport comparison benchmark.

   Keep `test/execute.benchmark.ts`, but add either an env switch or a separate
   wrapper so the same benchmark can run against:

   - stdio sidecar release binary
   - napi release addon

   This avoids comparing numbers from different branches or different command
   setups.

7. Re-run the ffca batch benchmark after the maintainable refactor.

   The microbenchmark shows the native boundary is much faster. The next useful
   system-level check is `packages/ffca/test/harness.benchmark.ts` to measure how
   much of that survives with real mutation preparation and DB persistence.

## Validation From POC

Commands run successfully in the POC worktree:

```bash
bun run --filter ffca-evm test
bun run --filter ffca-evm typecheck
bun run --filter ffca-evm lint
bun run lint
bun run typecheck
DATABASE_URL=postgres://postgres@localhost:5432/postgres bun run test
```
