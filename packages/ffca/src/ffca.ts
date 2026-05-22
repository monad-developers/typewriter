import { Data, Effect, Layer, Scope } from "effect";
import { getAbiItem, toEventSelector } from "viem";
import type { FFCAConfig } from "./config";
import { DatabaseConfig, layerDatabase } from "./db";
import { scopedDeploymentLock } from "./deployment-lock";
import type { FFCAAbi } from "./encoding";
import { deploymentLockKey, migrate } from "./migrate";
import { layerRpc, RpcConfig } from "./rpc";
import { createRuntimeEffect, type RuntimeFFCA } from "./runtime";
import { createMutationSchema } from "./schema";
import { layerWatchLive } from "./watch";

const DEFAULT_BLOCK_POLLING_INTERVAL_MS = 200;
const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;

export class FFCAConfigError extends Data.TaggedError("FFCAConfigError")<{
  readonly message: string;
}> {}

function primaryRpcUrl(
  rpcUrl: string | readonly string[],
): Effect.Effect<string, FFCAConfigError> {
  if (typeof rpcUrl === "string") return Effect.succeed(rpcUrl);
  const [first] = rpcUrl;
  if (first === undefined) {
    return Effect.fail(
      new FFCAConfigError({ message: "At least one RPC URL is required" }),
    );
  }
  return Effect.succeed(first);
}

export function createFFCAEffect<const C extends FFCAConfig>(
  config: C,
): Effect.Effect<RuntimeFFCA<C>, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    // TODO(kyle) check mutation names against sequencing order if applicable
    // TODO(kyle) check abi for execute, enqueue, and forceExecute

    const rpcUrl = yield* primaryRpcUrl(config.rpcUrl);
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
      pollIntervalMs:
        config.sequencing?.blockPollingIntervalMs ??
        DEFAULT_BLOCK_POLLING_INTERVAL_MS,
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
