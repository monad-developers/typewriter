import { Deferred, Effect, Layer, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageProxy } from "storage-layout";
import { getAbiItem, toEventSelector } from "viem";
import type {
  MutationsConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
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
  BatchListener,
  BlockListener,
  MutationListener,
  TypewriterMutationInput,
  TypewriterMutationResult,
} from "./types";
import { layerWatchLive } from "./watch";

export type RuntimeTypewriter<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageProxy<storageConfig, true>;
  readonly schema: TypewriterSchema<mutationsConfig, signatureConfig>;
  execute: (
    submitted: TypewriterMutationInput<mutationsConfig, signatureConfig>,
  ) => Effect.Effect<TypewriterMutationResult, unknown>;
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

export type RuntimeTypewriterWithDomain<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = RuntimeTypewriter<
  storageConfig,
  mutationsConfig,
  signatureConfig,
  sequencingConfig
> & {
  readonly domain: TypedData.Domain;
};

export type InternalRuntimeTypewriter<
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = Omit<
  RuntimeTypewriter<
    StorageConfig,
    MutationsConfig,
    SignatureConfig,
    sequencingConfig
  >,
  "execute"
> & {
  execute(submitted: {
    name: string;
    params: unknown;
    signature: unknown;
  }): Effect.Effect<TypewriterMutationResult, unknown>;
};

export type { BatchListener, BlockListener, MutationListener } from "./types";

export function createTypewriterEffect<
  const storageConfig extends StorageConfig,
  const mutationsConfig extends MutationsConfig,
  const signatureConfig extends SignatureConfig,
  const sequencingConfig extends SequencingConfig,
>(
  app: InternalApp,
): Effect.Effect<
  RuntimeTypewriterWithDomain<
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
        execute: (
          mutation: TypewriterMutationInput<mutationsConfig, signatureConfig>,
        ) =>
          fatalError === undefined
            ? runtime
                .execute({
                  name: mutation.name,
                  params: mutation.params,
                  signature: mutation.signature,
                })
                .pipe(Effect.raceFirst(Deferred.await(fatalSignal)))
            : Effect.fail(fatalError.error),
        domain: app.domain,
      } as unknown as RuntimeTypewriterWithDomain<
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
    RuntimeTypewriterWithDomain<
      storageConfig,
      mutationsConfig,
      signatureConfig,
      sequencingConfig
    >,
    unknown,
    Scope.Scope
  >;
}
