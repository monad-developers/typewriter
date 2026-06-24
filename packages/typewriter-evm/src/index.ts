// Effect-native client for the typewriter-evm native addon.

import { Data, Effect, Ref, type Scope, Semaphore } from "effect";
import type {
  BlockParams,
  ExecuteParams,
  ExecuteResult,
  InitParams,
  JournalIdsParams,
  ReadStorageParams,
  ReadStorageResult,
  Request,
  Response,
  SimulateParams,
} from "./types";

export type {
  AccountParams,
  BlockParams,
  ExecuteParams,
  ExecuteResult,
  InitParams,
  JournalIdsParams,
  ReadStorageParams,
  ReadStorageResult,
  SimulateParams,
  Spec,
} from "./types";

// The native addon is built by `napi build` (see package.json) and always
// staged at the same path regardless of profile: `bun run build` produces a
// release addon, `bun run build:debug` (used by `bun run test`) a debug one.
// Tests and production therefore load the exact same artifact and code path;
// only the compile profile differs, which changes optimization, not behavior.
const NATIVE_PATH = `${import.meta.dir}/../native/typewriter-evm.node`;

type NativeEvmHandle = {
  readonly call: (requestJson: string) => string;
};

type NativeAddon = {
  readonly NativeEvm: new () => NativeEvmHandle;
};

// -----------------------------------------------------------------------------
// Errors

export class EvmCrashed extends Data.TaggedError("EvmCrashed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class EvmCallError extends Data.TaggedError("EvmCallError")<{
  readonly method: Request["method"];
  readonly message: string;
  readonly cause: string;
}> {}

export class EvmProtocolError extends Data.TaggedError("EvmProtocolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type EvmError = EvmCrashed | EvmCallError | EvmProtocolError;

// -----------------------------------------------------------------------------
// Public API

export type EVM = {
  readonly init: (params: InitParams) => Effect.Effect<void, EvmError>;
  readonly setBlockContext: (
    params: BlockParams,
  ) => Effect.Effect<void, EvmError>;
  readonly execute: (
    params: ExecuteParams,
  ) => Effect.Effect<ExecuteResult, EvmError>;
  readonly simulate: (
    params: SimulateParams,
  ) => Effect.Effect<ExecuteResult, EvmError>;
  readonly readStorage: (
    params: ReadStorageParams,
  ) => Effect.Effect<ReadStorageResult, EvmError>;
  readonly revertJournals: (
    params: JournalIdsParams,
  ) => Effect.Effect<void, EvmError>;
  readonly pruneJournals: (
    params: JournalIdsParams,
  ) => Effect.Effect<void, EvmError>;
};

function loadNativeAddon(): NativeAddon {
  try {
    return require(NATIVE_PATH) as NativeAddon;
  } catch (cause) {
    throw new EvmCrashed({
      message:
        `failed to load typewriter-evm native addon at ${NATIVE_PATH}; ` +
        "run `bun run --filter typewriter-evm build:debug` for tests or `bun run --filter typewriter-evm build` for release",
      cause,
    });
  }
}

// Creates one native EVM harness per createEVM. A semaphore (capacity 1)
// serializes calls so the harness only ever sees one request at a time.
export const createEVM = (): Effect.Effect<EVM, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const native = new (loadNativeAddon().NativeEvm)();
      const sem = yield* Semaphore.make(1);
      const locked = sem.withPermits(1);
      const idCounterRef = yield* Ref.make(1);

      const call = <T>(
        method: Request["method"],
        build: (id: number) => Request,
      ): Effect.Effect<T, EvmError> =>
        locked(
          Effect.gen(function* () {
            const id = yield* Ref.getAndUpdate(idCounterRef, (n) => n + 1);
            const req = build(id);

            const responseJson = yield* Effect.try({
              try: () => native.call(JSON.stringify(req)),
              catch: (e) =>
                new EvmCrashed({ message: "native call failed", cause: e }),
            });

            const res = yield* Effect.try({
              try: () => JSON.parse(responseJson) as Response,
              catch: (e) =>
                new EvmProtocolError({
                  message: `invalid response JSON: ${responseJson}`,
                  cause: e,
                }),
            });
            if (res.id !== id) {
              const responseError = res.ok ? undefined : res.error;
              // Mismatches often mean the TypeScript client and native addon
              // are out of sync.
              return yield* new EvmProtocolError({
                message:
                  `response id mismatch for ${method}: expected ${id}, got ${res.id}` +
                  (responseError === undefined
                    ? ""
                    : `; response error: ${responseError}`),
              });
            }
            if (!res.ok) {
              return yield* new EvmCallError({
                method,
                message: `${method} failed: ${res.error}`,
                cause: res.error,
              });
            }
            return res.result as T;
          }),
        );

      const evm: EVM = {
        init: (params) =>
          call<unknown>("init", (id) => ({ method: "init", id, params })).pipe(
            Effect.asVoid,
          ),
        setBlockContext: (params) =>
          call<unknown>("setBlockContext", (id) => ({
            method: "setBlockContext",
            id,
            params,
          })).pipe(Effect.asVoid),
        execute: (params) =>
          call<ExecuteResult>("execute", (id) => ({
            method: "execute",
            id,
            params,
          })),
        simulate: (params) =>
          call<ExecuteResult>("simulate", (id) => ({
            method: "simulate",
            id,
            params,
          })),
        readStorage: (params) =>
          call<ReadStorageResult>("readStorage", (id) => ({
            method: "readStorage",
            id,
            params,
          })),
        revertJournals: (params) =>
          call<unknown>("revertJournals", (id) => ({
            method: "revertJournals",
            id,
            params,
          })).pipe(Effect.asVoid),
        pruneJournals: (params) =>
          call<unknown>("pruneJournals", (id) => ({
            method: "pruneJournals",
            id,
            params,
          })).pipe(Effect.asVoid),
      };

      return evm;
    }),
    () => Effect.void,
  );
