import { Deferred, Effect, Layer, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageProxy } from "storage-layout";
import { getAbiItem, toEventSelector } from "viem";
import type { FFCAConfig } from "./config";
import { buildInternalApp } from "./config";
import { DatabaseConfig, layerDatabase } from "./db";
import { scopedDeploymentLock } from "./deployment-lock";
import { FFCA_ABI } from "./encoding";
import type { InternalApp } from "./internal";
import { loggerLayer } from "./logger";
import { deploymentLockKey, migrate } from "./migrate";
import { layerRpc, RpcConfig } from "./rpc";
import { createRuntimeEffect } from "./runtime";
import type { FFCASchema } from "./schema";
import type {
  BatchEvent,
  BlockEvent,
  FFCAMutation,
  FFCAMutationResult,
  MutationEvent,
} from "./types";
import { layerWatchLive } from "./watch";

export type MutationListener = (event: MutationEvent) => void;
export type BatchListener = (event: BatchEvent) => void;
export type BlockListener<sequence extends "fifo" | "batch"> = (
  event: BlockEvent<sequence>,
) => void;

export type InternalRuntimeFFCA<sequence extends "fifo" | "batch"> = {
  readonly state: StorageProxy<InternalApp["storageLayout"], true>;
  readonly schema: InternalApp["schema"];
  execute(submitted: FFCAMutation): Effect.Effect<FFCAMutationResult, unknown>;
  program: Effect.Effect<unknown, unknown>;
} & (sequence extends "fifo"
  ? {
      on(event: "mutation", cb: MutationListener): Effect.Effect<() => void>;
      on(
        event: "block",
        cb: BlockListener<sequence>,
      ): Effect.Effect<() => void>;
    }
  : {
      on(event: "mutation", cb: MutationListener): Effect.Effect<() => void>;
      on(event: "batch", cb: BatchListener): Effect.Effect<() => void>;
      on(
        event: "block",
        cb: BlockListener<sequence>,
      ): Effect.Effect<() => void>;
    });

export type RuntimeFFCA<
  config extends FFCAConfig,
  sequence extends "fifo" | "batch",
> = Omit<InternalRuntimeFFCA<sequence>, "schema" | "state"> & {
  readonly state: StorageProxy<config["storageLayout"], true>;
  readonly schema: FFCASchema<config>;
};

export type RuntimeFFCAWithDomain<
  config extends FFCAConfig,
  sequence extends "fifo" | "batch",
> = RuntimeFFCA<config, sequence> & {
  readonly domain: TypedData.Domain;
};

export function createFFCAEffect<const C extends FFCAConfig>(
  config: C,
): Effect.Effect<
  RuntimeFFCAWithDomain<C, "fifo" | "batch">,
  unknown,
  Scope.Scope
> {
  return Effect.gen(function* () {
    // TODO(kyle) check mutation names against sequencing order if applicable
    // TODO(kyle) validate the fixed FFCA entrypoints

    const app = yield* Effect.try({
      try: () => buildInternalApp(config),
      catch: (cause) => cause,
    });

    const rpcLayer = layerRpc.pipe(
      Layer.provide(Layer.succeed(RpcConfig)({ rpcUrls: app.rpcUrls })),
    );

    const dbLayer = layerDatabase.pipe(
      Layer.provide(Layer.succeed(DatabaseConfig)(app.database)),
    );

    const forceInclusionEvent = getAbiItem({
      abi: FFCA_ABI,
      name: "ForceInclusionQueued",
    });

    const logFilter = {
      address: app.address,
      selector: toEventSelector(forceInclusionEvent),
    };
    const watchLayer = layerWatchLive({
      pollIntervalMs: app.blockPollingIntervalMs,
      maxChainDepth: app.confirmations.finalizedBlockDepth,
      logFilter,
    }).pipe(Layer.provide(rpcLayer));
    const services = rpcLayer.pipe(
      Layer.merge(dbLayer),
      Layer.merge(watchLayer),
    );
    const scope = yield* Scope.Scope;
    const servicesContext = yield* Layer.buildWithScope(services, scope);

    return yield* Effect.gen(function* () {
      yield* scopedDeploymentLock(deploymentLockKey(app.chainId, app.address));
      yield* migrate(app.schema, app.chainId, app.address);

      const runtime = yield* createRuntimeEffect(app);

      let fatalError: { readonly error: unknown } | undefined;
      const fatalSignal = yield* Deferred.make<never, unknown>();

      yield* runtime.program.pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            fatalError = { error };
            yield* Deferred.fail(fatalSignal, error);
            yield* Effect.sync(() => {
              if (app.onFatalError !== undefined) {
                app.onFatalError(error);
              } else {
                queueMicrotask(() => {
                  throw error;
                });
              }
            });
            yield* Effect.logError(error);
          }),
        ),
        Effect.forkScoped,
      );

      return {
        ...runtime,
        execute: (mutation: FFCAMutation) =>
          fatalError === undefined
            ? runtime
                .execute(mutation)
                .pipe(Effect.raceFirst(Deferred.await(fatalSignal)))
            : Effect.fail(fatalError.error),
        domain: app.domain,
      } as unknown as RuntimeFFCAWithDomain<C, "fifo" | "batch">;
    }).pipe(Effect.provide(servicesContext));
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.provide(loggerLayer),
  );
}
