// Effect-native client for the evm sidecar.
//
// One subprocess per createEVM. A semaphore (capacity 1) serializes calls so
// only one request is in flight at a time. The reader fiber parses stdout
// lines and pushes responses onto a queue; each call writes its request and
// then takes one response. On EOF the reader shuts the queue down, which
// fails any in-flight take with InterruptedException and propagates out.

import { type Subprocess, spawn } from "bun";
import { Data, Effect, Queue, Ref, type Scope, Semaphore } from "effect";
import type {
  ExecuteParams,
  ExecuteResult,
  InitParams,
  ReadStorageParams,
  ReadStorageResult,
  Request,
  Response,
} from "./types";

export type {
  AccountParams,
  BlockParams,
  ExecuteParams,
  ExecuteResult,
  InitParams,
  ReadStorageParams,
  ReadStorageResult,
  Spec,
} from "./types";

const BINARY_PATH = `${import.meta.dir}/../target/${Bun.env.NODE_ENV === "test" ? "debug" : "release"}/evm`;

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
  readonly beginBundle: () => Effect.Effect<void, EvmError>;
  readonly execute: (
    params: ExecuteParams,
  ) => Effect.Effect<ExecuteResult, EvmError>;
  readonly simulate: (
    params: ExecuteParams,
  ) => Effect.Effect<ExecuteResult, EvmError>;
  readonly readStorage: (
    params: ReadStorageParams,
  ) => Effect.Effect<ReadStorageResult, EvmError>;
  readonly commitBundles: () => Effect.Effect<void, EvmError>;
  readonly revertBundle: () => Effect.Effect<void, EvmError>;
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

      const responses = yield* Queue.unbounded<Response, EvmError>();
      const sem = yield* Semaphore.make(1);
      const locked = sem.withPermits(1);
      const idCounterRef = yield* Ref.make(1);

      // Reader fiber — buffers stdout, splits on \n, offers each parsed
      // response. On EOF, read error, or parse error, fails the response queue
      // so any in-flight call observes a typed EvmError.
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
            if (!line.trim()) continue;
            const parsed = yield* Effect.try({
              try: () => JSON.parse(line) as Response,
              catch: (e) =>
                new EvmProtocolError({
                  message: `invalid response JSON: ${line}`,
                  cause: e,
                }),
            });
            yield* Queue.offer(responses, parsed);
          }
        }
      });

      yield* readerEffect.pipe(
        Effect.catch((error) =>
          Queue.fail(responses, error).pipe(Effect.asVoid),
        ),
        Effect.ensuring(Queue.shutdown(responses)),
        Effect.forkScoped,
      );

      const call = <T>(
        method: Request["method"],
        build: (id: number) => Request,
      ): Effect.Effect<T, EvmError> =>
        locked(
          Effect.gen(function* () {
            const id = yield* Ref.getAndUpdate(idCounterRef, (n) => n + 1);
            const req = build(id);

            yield* Effect.try({
              try: () => {
                proc.stdin.write(`${JSON.stringify(req)}\n`);
                proc.stdin.flush();
              },
              catch: (e) =>
                new EvmCrashed({ message: "stdin write failed", cause: e }),
            });

            const res = yield* Queue.take(responses);
            if (res.id !== id) {
              const responseError = res.ok ? undefined : res.error;
              // Mismatches often mean the TypeScript client and sidecar binary
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
        beginBundle: () =>
          call<unknown>("beginBundle", (id) => ({
            method: "beginBundle",
            id,
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
        commitBundles: () =>
          call<unknown>("commitBundles", (id) => ({
            method: "commitBundles",
            id,
          })).pipe(Effect.asVoid),
        revertBundle: () =>
          call<unknown>("revertBundle", (id) => ({
            method: "revertBundle",
            id,
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
