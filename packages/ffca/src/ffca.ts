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
import { createRuntimeBatchEffect } from "./runtime-batch";
import { createRuntimeFIFOEffect } from "./runtime-fifo";
import type { FFCASchema } from "./schema";
import { createMutationSchema } from "./schema";
import type {
  BatchEvent,
  BlockEvent,
  FFCAMutation,
  FFCAMutationResult,
  MutationEvent,
} from "./types";
import { layerWatchLive } from "./watch";

const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;

export type MutationListener = (event: MutationEvent) => void;
export type BatchListener = (event: BatchEvent) => void;
export type BlockListener<sequence extends "fifo" | "batch"> = (
  event: BlockEvent<sequence>,
) => void;

export type RuntimeFFCA<
  C extends FFCAConfig,
  sequence extends "fifo" | "batch",
> = {
  readonly state: StorageProxy<C["storageLayout"], true>;
  readonly schema: FFCASchema<C>;
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

export type RuntimeFFCAWithDomain<
  C extends FFCAConfig,
  sequence extends "fifo" | "batch",
> = RuntimeFFCA<C, sequence> & {
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
    // TODO(kyle) check abi for execute, enqueue, and forceExecute

    yield* Effect.try({
      try: () => validateConfig(config),
      catch: (cause) => cause,
    });

    const rpcUrl = Array.isArray(config.rpcUrl)
      ? config.rpcUrl[0]!
      : config.rpcUrl;
    const domain: TypedData.Domain = {
      name: config.domain.name,
      version: config.domain.version,
      chainId: config.chainId,
      verifyingContract: config.address,
    };
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

      let runtime: RuntimeFFCA<C, "fifo" | "batch">;
      if (config.sequencing?.order === "batch") {
        runtime = yield* createRuntimeBatchEffect(config, schema);
      } else {
        runtime = yield* createRuntimeFIFOEffect(config, schema);
      }

      yield* Effect.forkScoped(runtime.program);

      return {
        ...runtime,
        domain,
      };
    }).pipe(Effect.provide(servicesContext));
  });
}
