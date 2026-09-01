import { Deferred, Effect, Layer, Scope } from "effect";
import type { StorageProxy } from "storage-layout";
import { getAbiItem, toEventSelector } from "viem";
import type {
  MutationsConfig,
  SequencingConfig,
  StorageConfig,
  TypewriterManifest,
} from "./config";
import { DatabaseConfig, layerDatabase } from "./db";
import { scopedDeploymentLock } from "./deployment-lock";
import type { TYPEWRITER_ABI } from "./encoding";
import type { InternalApp } from "./internal";
import { loggerLayer } from "./logger";
import { deploymentLockKey, migrate } from "./migrate";
import { layerRpc, RpcConfig } from "./rpc";
import { requestExecutionIndex } from "./rpc-request";
import { createRuntimeEffect } from "./runtime";
import type { TypewriterSchema } from "./schema";
import type {
  Authorization,
  BatchListener,
  BlockListener,
  MutationListener,
  TypewriterMutationInput,
  TypewriterMutationResult,
} from "./types";
import { layerWatchLive } from "./watch";

type StorageRootProperty<
  storageConfig extends StorageConfig,
  name extends "accounts" | "state",
> =
  StorageProxy<storageConfig, true> extends infer root
    ? name extends keyof root
      ? root[name]
      : never
    : never;

type RuntimeListeners<
  mutationsConfig extends MutationsConfig,
  sequencingConfig extends SequencingConfig,
> = sequencingConfig extends "fifo"
  ? {
      on(
        event: "mutation",
        cb: MutationListener<mutationsConfig>,
      ): Effect.Effect<() => void>;
      on(
        event: "block",
        cb: BlockListener<sequencingConfig, mutationsConfig>,
      ): Effect.Effect<() => void>;
    }
  : {
      on(
        event: "mutation",
        cb: MutationListener<mutationsConfig>,
      ): Effect.Effect<() => void>;
      on(
        event: "batch",
        cb: BatchListener<mutationsConfig>,
      ): Effect.Effect<() => void>;
      on(
        event: "block",
        cb: BlockListener<sequencingConfig, mutationsConfig>,
      ): Effect.Effect<() => void>;
    };

export type RuntimeTypewriter<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageRootProperty<storageConfig, "state">;
  readonly accounts: StorageRootProperty<storageConfig, "accounts">;
  readonly schema: TypewriterSchema<mutationsConfig>;
  readonly manifest: TypewriterManifest<mutationsConfig>;
  execute: (
    submitted: TypewriterMutationInput<mutationsConfig>,
  ) => Effect.Effect<TypewriterMutationResult, unknown>;
  program: Effect.Effect<unknown, unknown>;
} & RuntimeListeners<mutationsConfig, sequencingConfig>;

export type InternalRuntimeTypewriter<
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageProxy<StorageConfig, true>[string];
  readonly accounts: StorageProxy<StorageConfig, true>[string];
  readonly schema: TypewriterSchema;
  execute(submitted: {
    name: string;
    params: unknown;
    authorization: Authorization;
  }): Effect.Effect<TypewriterMutationResult, unknown>;
  program: Effect.Effect<unknown, unknown>;
} & RuntimeListeners<MutationsConfig, sequencingConfig>;

export type { BatchListener, BlockListener, MutationListener } from "./types";

export function createTypewriterEffect<
  const storageConfig extends StorageConfig,
  const mutationsConfig extends MutationsConfig,
  const sequencingConfig extends SequencingConfig,
>(
  app: InternalApp,
): Effect.Effect<
  RuntimeTypewriter<storageConfig, mutationsConfig, sequencingConfig>,
  unknown,
  Scope.Scope
> {
  return Effect.gen(function* () {
    // TODO(kyle) check mutation names against sequencing order if applicable
    // TODO(kyle) validate the fixed Typewriter entrypoints

    const rpcLayer = layerRpc.pipe(
      Layer.provide(Layer.succeed(RpcConfig)({ rpcUrls: app.rpcUrls })),
    );

    const dbLayer = layerDatabase.pipe(
      Layer.provide(Layer.succeed(DatabaseConfig)(app.database)),
    );

    const forceInclusionEvent = getAbiItem({
      abi: app.abi as typeof TYPEWRITER_ABI,
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
      const executionIndex = yield* requestExecutionIndex(app.address);
      yield* migrate(app.schema, app.chainId, app.address, executionIndex);

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
        execute: (mutation: TypewriterMutationInput<mutationsConfig>) =>
          fatalError === undefined
            ? runtime
                .execute({
                  name: mutation.name,
                  params: mutation.params,
                  authorization: mutation.authorization,
                })
                .pipe(Effect.raceFirst(Deferred.await(fatalSignal)))
            : Effect.fail(fatalError.error),
        manifest: app.manifest,
      } as unknown as RuntimeTypewriter<
        storageConfig,
        mutationsConfig,
        sequencingConfig
      >;
    }).pipe(Effect.provide(servicesContext));
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.provide(loggerLayer),
  ) as Effect.Effect<
    RuntimeTypewriter<storageConfig, mutationsConfig, sequencingConfig>,
    unknown,
    Scope.Scope
  >;
}
