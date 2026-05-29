# executeMany Plan

## Goal

Reduce JS <-> Rust overhead in `packages/ffca/src/runtime-batch.ts` by batching multiple EVM `execute` calls into one ffca-evm request.

## Why this matters

`acceptBatch` already collects mutations into a list. Today each mutation still pays a separate IPC round trip to ffca-evm. A batched request should keep the current sequential semantics while removing most of the transport overhead.

## Proposed shape

### Request

Add a new wire method in ffca-evm:

```rust
ExecuteMany { id: u64, params: ExecuteManyParams }

struct ExecuteManyParams {
    calls: Vec<ExecuteParams>,
}
```

`ExecuteParams` stays unchanged:

```ts
{
  from: Address;
  to: Address;
  data: Hex;
  value?: Hex;
}
```

### Response

Return results in the same order as the input calls:

```rust
struct ExecuteManyOk {
    results: Vec<ExecuteOk>,
}
```

## Runtime-batch usage

Use `executeMany` first in `acceptBatch`.

1. Collect the mutations that are about to be accepted.
2. Resolve and encode them into a single `calls` array.
3. Send one `executeMany` request to ffca-evm.
4. Zip the returned `ExecuteOk[]` back onto the original mutations by index.
5. Preserve existing per-mutation behavior:
   - reject individual failures
   - assign `journalId` on success
   - invalidate storage cache from returned slot writes
   - collect known paths
   - persist accepted mutations
   - emit the same events

`watchProgram` can stay on single-call `execute` initially.

## Rollout order

1. Add `ExecuteMany` to `packages/ffca-evm/src/main.rs` and `packages/ffca-evm/src/types.ts`.
2. Add `executeMany` to `packages/ffca-evm/src/index.ts`.
3. Add a batched helper in `packages/ffca/src/runtime-batch.ts`.
4. Switch `acceptBatch` to use the batched helper.
5. Benchmark against the current baseline.

## Non-goals

- Changing acceptance semantics.
- Retrying or skipping failures inside ffca-evm.
- Replacing the sidecar with `napi-rs` or WASM.

## Measurement target

The first question is whether batching the IPC call produces a meaningful win before any deeper runtime or transport changes.
