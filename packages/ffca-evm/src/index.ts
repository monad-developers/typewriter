// Effect-native client for the ffca-evm sidecar.
//
// One subprocess per createEVM. Each request carries a monotonically
// increasing id; the reader fiber dispatches responses to per-call Deferreds
// keyed by that id. This makes the protocol interruption-safe: if a caller is
// interrupted between sending and awaiting, it removes its deferred from the
// pending map, and the eventual response is looked up, not found, and
// silently discarded. It also lets multiple calls be in flight concurrently —
// the sidecar processes them in arrival order.
//
// On reader EOF / read error / parse error every pending deferred is failed
// with a typed EvmError and a sticky death flag is set so subsequent calls
// fail with the same error rather than registering a deferred that would
// never resolve.

import { type Subprocess, spawn } from "bun";
import { Data, Deferred, Effect, type Scope } from "effect";
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

const BINARY_PATH = `${import.meta.dir}/../target/${Bun.env.NODE_ENV === "test" ? "debug" : "release"}/ffca-evm`;

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

// Spawns the sidecar and returns the client. Uses acquireRelease so the
// subprocess is killed on scope close. Caller composes with Effect.scoped.
export const createEVM = (): Effect.Effect<EVM, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const proc: Subprocess<"pipe", "pipe", "inherit"> = spawn({
        cmd: [BINARY_PATH],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      // In-flight calls register a Deferred under their request id; the
      // reader fiber resolves them as responses arrive. An interrupted caller
      // removes its entry, so the eventual response is dispatched to no one.
      const pending = new Map<number, Deferred.Deferred<Response, EvmError>>();
      let idCounter = 1;
      // Sticky failure: once the reader fiber dies, every subsequent call
      // fails with the same error rather than registering a deferred that
      // would never be resolved.
      let deathError: EvmError | undefined;

      const failPending = (error: EvmError) =>
        Effect.gen(function* () {
          const deferreds = [...pending.values()];
          pending.clear();
          for (const deferred of deferreds) {
            yield* Deferred.fail(deferred, error);
          }
        });

      // Reader fiber — buffers stdout, splits on \n, dispatches each parsed
      // response to its registered deferred by id. On EOF, read error, or
      // parse error, fails every pending deferred and marks the protocol
      // dead so subsequent calls also fail.
      const readerEffect = Effect.gen(function* () {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (e) =>
              new EvmCrashed({ message: "stdout read failed", cause: e }),
          });
          if (chunk.done) {
            return yield* new EvmCrashed({
              message: "subprocess stdout closed",
            });
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          for (;;) {
            const idx = buffer.indexOf("\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.trim() === "") continue;
            const parsed = yield* Effect.try({
              try: () => JSON.parse(line) as Response,
              catch: (e) =>
                new EvmProtocolError({
                  message: `invalid response JSON: ${line}`,
                  cause: e,
                }),
            });
            const deferred = pending.get(parsed.id);
            if (deferred === undefined) {
              // Caller was interrupted between sending the request and
              // awaiting the response; drop the orphan.
              continue;
            }
            pending.delete(parsed.id);
            yield* Deferred.succeed(deferred, parsed);
          }
        }
      });

      yield* readerEffect.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            deathError = error;
            yield* failPending(error);
          }),
        ),
        Effect.forkScoped,
      );

      const call = <T>(
        method: Request["method"],
        build: (id: number) => Request,
      ): Effect.Effect<T, EvmError> =>
        Effect.acquireUseRelease(
          // Acquire (uninterruptible): claim an id, create a deferred,
          // register it. If the reader has already died, fail upfront
          // instead of registering a deferred that would never resolve.
          Effect.gen(function* () {
            if (deathError !== undefined) {
              return yield* Effect.fail(deathError);
            }
            const id = idCounter++;
            const deferred = yield* Deferred.make<Response, EvmError>();
            if (deathError !== undefined) {
              return yield* Effect.fail(deathError);
            }
            pending.set(id, deferred);
            return { id, deferred };
          }),
          // Use (interruptible): send the request and await the response.
          // If the caller is interrupted here, release still runs and the
          // pending entry is dropped, so the orphan response is discarded
          // by the reader when it eventually arrives.
          ({ id, deferred }) =>
            Effect.gen(function* () {
              const req = build(id);
              yield* Effect.try({
                try: () => {
                  proc.stdin.write(`${JSON.stringify(req)}\n`);
                  proc.stdin.flush();
                },
                catch: (e) =>
                  new EvmCrashed({ message: "stdin write failed", cause: e }),
              });
              const res = yield* Deferred.await(deferred);
              if (!res.ok) {
                return yield* new EvmCallError({
                  method,
                  message: `${method} failed: ${res.error}`,
                  cause: res.error,
                });
              }
              return res.result as T;
            }),
          // Release (uninterruptible): remove our entry. Idempotent if the
          // reader already removed it on dispatch, or if failPending
          // cleared the map on reader death.
          ({ id }) =>
            Effect.sync(() => {
              pending.delete(id);
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

      return { evm, proc };
    }),
    ({ proc }) =>
      Effect.gen(function* () {
        try {
          proc.stdin.end();
        } catch {}
        proc.kill();
        yield* Effect.promise(() => proc.exited);
      }).pipe(Effect.ignore),
  ).pipe(Effect.map(({ evm }) => evm));
