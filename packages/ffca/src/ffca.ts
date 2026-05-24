import { Effect, Layer, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageProxy } from "storage-layout";
import { getAbiItem, toEventSelector } from "viem";
import type { FFCAConfig } from "./config";
import { validateConfig } from "./config";
import { DatabaseConfig, layerDatabase } from "./db";
import { scopedDeploymentLock } from "./deployment-lock";
import type { FFCAAbi } from "./encoding";
import { deploymentLockKey, migrate } from "./migrate";
import { layerRpc, RpcConfig } from "./rpc";
import { createRuntimeEffect } from "./runtime";
import type { FFCASchema } from "./schema";
import { createMutationSchema } from "./schema";
import type {
  BlockEvent,
  BundleEvent,
  MutationEvent,
  SubmittedMutation,
} from "./types";
import { layerWatchLive } from "./watch";

const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;

export type MutationListener = (event: MutationEvent) => void;
export type BundleListener = (event: BundleEvent) => void;
export type BlockListener = (event: BlockEvent) => void;

export type RuntimeFFCA<C extends FFCAConfig> = {
  readonly state: StorageProxy<C["storageLayout"], true>;
  readonly schema: FFCASchema<C>;
  readonly domain: TypedData.Domain;
  execute(submitted: SubmittedMutation): Effect.Effect<MutationEvent, unknown>;
  on(event: "mutation", cb: MutationListener): Effect.Effect<() => void>;
  on(event: "bundle", cb: BundleListener): Effect.Effect<() => void>;
  on(event: "block", cb: BlockListener): Effect.Effect<() => void>;
};

export function createFFCAEffect<const C extends FFCAConfig>(
  config: C,
): Effect.Effect<RuntimeFFCA<C>, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    // TODO(kyle) check mutation names against sequencing order if applicable
    // TODO(kyle) check abi for execute, enqueue, and forceExecute

    yield* Effect.try({
      try: () => validateConfig(config),
      catch: (cause) => cause,
    });

    const rpcUrl = Array.isArray(config.rpcUrl)
      ? config.rpcUrl[0]!
      : config.rpcUrl;
    const rpcLayer = layerRpc.pipe(
      Layer.provide(Layer.succeed(RpcConfig)({ rpcUrl })),
    );

    const dbLayer = layerDatabase.pipe(
      Layer.provide(Layer.succeed(DatabaseConfig)(config.database)),
    );

    const forceInclusionEvent = getAbiItem({
      abi: config.abi as FFCAAbi,
      name: "ForceInclusionQueued",
    });

    const logFilter = {
      address: config.address,
      selector: toEventSelector(forceInclusionEvent),
    };
    const watchLayer = layerWatchLive({
      pollIntervalMs: config.blockPollingIntervalMs ?? 200,
      maxChainDepth:
        config.confirmations?.finalizedBlockDepth ??
        DEFAULT_FINALIZED_BLOCK_DEPTH,
      logFilter,
    }).pipe(Layer.provide(rpcLayer));
    const services = rpcLayer.pipe(
      Layer.merge(dbLayer),
      Layer.merge(watchLayer),
    );
    const scope = yield* Scope.Scope;
    const servicesContext = yield* Layer.buildWithScope(services, scope);

    return yield* Effect.gen(function* () {
      yield* scopedDeploymentLock(
        deploymentLockKey(config.chainId, config.address),
      );
      const schema = yield* Effect.try({
        try: () => createMutationSchema(config),
        catch: (cause) => cause,
      });
      yield* migrate(schema, config.chainId, config.address);

      return yield* createRuntimeEffect(config, schema);
    }).pipe(Effect.provide(servicesContext));
  });
}
