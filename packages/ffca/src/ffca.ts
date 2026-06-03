import { Deferred, Effect, Layer, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageProxy } from "storage-layout";
import { getAbiItem, toEventSelector } from "viem";
import type {
  FFCAConfig,
  MutationsConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
} from "./config";
import { buildInternalApp } from "./config";
import { DatabaseConfig, layerDatabase } from "./db";
import { scopedDeploymentLock } from "./deployment-lock";
import { FFCA_ABI } from "./encoding";
import { loggerLayer } from "./logger";
import { deploymentLockKey, migrate } from "./migrate";
import { layerRpc, RpcConfig } from "./rpc";
import { createRuntimeEffect } from "./runtime";
import type { FFCASchema } from "./schema";
import type {
  BatchListener,
  BlockListener,
  FFCAMutationInput,
  FFCAMutationResult,
  MutationListener,
} from "./types";
import { layerWatchLive } from "./watch";

export type RuntimeFFCA<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageProxy<storageConfig, true>;
  readonly schema: FFCASchema<mutationsConfig>;
  execute: <const name extends keyof mutationsConfig & string>(
    submitted: FFCAMutationInput<mutationsConfig, signatureConfig, name>,
  ) => Effect.Effect<FFCAMutationResult<mutationsConfig[name]>, unknown>;
  program: Effect.Effect<unknown, unknown>;
} & (sequencingConfig extends "fifo"
  ? {
      on(
        event: "mutation",
        cb: MutationListener<mutationsConfig, signatureConfig>,
      ): Effect.Effect<() => void>;
      on(
        event: "block",
        cb: BlockListener<sequencingConfig, mutationsConfig, signatureConfig>,
      ): Effect.Effect<() => void>;
    }
  : {
      on(
        event: "mutation",
        cb: MutationListener<mutationsConfig, signatureConfig>,
      ): Effect.Effect<() => void>;
      on(
        event: "batch",
        cb: BatchListener<mutationsConfig, signatureConfig>,
      ): Effect.Effect<() => void>;
      on(
        event: "block",
        cb: BlockListener<sequencingConfig, mutationsConfig, signatureConfig>,
      ): Effect.Effect<() => void>;
    });

export type RuntimeFFCAWithDomain<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = RuntimeFFCA<
  storageConfig,
  mutationsConfig,
  signatureConfig,
  sequencingConfig
> & {
  readonly domain: TypedData.Domain;
};

export type InternalRuntimeFFCA<
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = Omit<
  RuntimeFFCA<
    StorageConfig,
    MutationsConfig,
    SignatureConfig,
    sequencingConfig
  >,
  "execute"
> & {
  execute(
    submitted:
      | {
          name: string;
          args: unknown;
          signature: unknown;
        }
      | {
          name: string;
          params: unknown;
          signature: unknown;
        },
  ): Effect.Effect<FFCAMutationResult, unknown>;
};

export type { BatchListener, BlockListener, MutationListener } from "./types";

export function createFFCAEffect<
  const storageConfig extends StorageConfig,
  const mutationsConfig extends MutationsConfig,
  const signatureConfig extends SignatureConfig,
  const sequencingConfig extends SequencingConfig,
>(
  config: FFCAConfig<sequencingConfig>,
): Effect.Effect<
  RuntimeFFCAWithDomain<
    storageConfig,
    mutationsConfig,
    signatureConfig,
    sequencingConfig
  >,
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
        execute: (
          mutation: FFCAMutationInput<mutationsConfig, signatureConfig>,
        ) =>
          fatalError === undefined
            ? runtime
                .execute({
                  name: mutation.name,
                  args: mutation.params,
                  signature: mutation.signature,
                })
                .pipe(Effect.raceFirst(Deferred.await(fatalSignal)))
            : Effect.fail(fatalError.error),
        domain: app.domain,
      } as unknown as RuntimeFFCAWithDomain<
        storageConfig,
        mutationsConfig,
        signatureConfig,
        sequencingConfig
      >;
    }).pipe(Effect.provide(servicesContext));
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.provide(loggerLayer),
  ) as Effect.Effect<
    RuntimeFFCAWithDomain<
      storageConfig,
      mutationsConfig,
      signatureConfig,
      sequencingConfig
    >,
    unknown,
    Scope.Scope
  >;
}
