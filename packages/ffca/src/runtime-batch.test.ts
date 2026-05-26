import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { type Address, getAbiItem, toEventSelector } from "viem";
import { anvil } from "viem/chains";
import {
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_PUBLIC_CLIENT,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  COUNTER_ABI,
  COUNTER_DOMAIN,
  COUNTER_MUTATIONS,
  COUNTER_STORAGE_LAYOUT,
  deployCounter,
  signCounter,
} from "../test/utils";
import type { FFCAConfig } from "./config";
import { layerDatabaseLive } from "./db";
import { migrate } from "./migrate";
import { layerRpcLive } from "./rpc";
import { createRuntimeBatchEffect } from "./runtime-batch";
import { createMutationSchema } from "./schema";
import type { BatchEvent } from "./types";
import { layerWatchLive } from "./watch";

function createCounterConfig(
  address: Address,
  options: {
    readonly batchIntervalMs?: number;
    readonly submitIntervalMs?: number;
  } = {},
) {
  return {
    address,
    domain: COUNTER_DOMAIN,
    abi: COUNTER_ABI,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchIntervalMs: options.batchIntervalMs ?? 100,
      submitIntervalMs: options.submitIntervalMs ?? 1000,
      batchOrder: ["add"],
    },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;
}

async function createRuntimeFixture(
  options: {
    readonly batchIntervalMs?: number;
    readonly submitIntervalMs?: number;
  } = {},
) {
  const address = await deployCounter(USER_ACCOUNT.address);
  const code = await TEST_PUBLIC_CLIENT.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new Error(`no contract code at ${address}`);
  }

  const config = createCounterConfig(address, options);
  const scope = Effect.runSync(Scope.make());

  try {
    const rpcLayer = layerRpcLive({ rpcUrl: TEST_RPC_URL });
    const dbLayer = layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 });
    const forceInclusionEvent = getAbiItem({
      abi: COUNTER_ABI,
      name: "ForceInclusionQueued",
    });
    const watchLayer = layerWatchLive({
      pollIntervalMs: 200,
      maxChainDepth: 5,
      logFilter: {
        address,
        selector: toEventSelector(forceInclusionEvent),
      },
    }).pipe(Layer.provide(rpcLayer));
    const services = rpcLayer.pipe(
      Layer.merge(dbLayer),
      Layer.merge(watchLayer),
    );
    const servicesContext = await Effect.runPromise(
      Layer.buildWithScope(services, scope),
    );

    const runtime = await Effect.runPromise(
      Effect.gen(function* () {
        const schema = createMutationSchema(config);
        yield* migrate(schema, config.chainId, config.address).pipe(
          Effect.provide(servicesContext),
        );

        return yield* createRuntimeBatchEffect(config, schema).pipe(
          Effect.provide(servicesContext),
          Effect.provideService(Scope.Scope, scope),
        );
      }),
    );

    return { address, config, runtime, scope };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

async function closeScope(scope: Scope.Scope) {
  await Effect.runPromise(Scope.close(scope, Exit.void));
}

function signedAdd(params: {
  readonly address: Address;
  readonly amount: bigint;
  readonly nonce: bigint;
}) {
  return {
    name: "add",
    args: { amount: params.amount, nonce: params.nonce },
    signature: signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: params.amount,
      nonce: params.nonce,
      address: params.address,
      chainId: anvil.id,
    }),
  };
}

test(
  "Batch runtime execute waits for the batch sweep",
  async () => {
    const batchIntervalMs = 200;
    const { address, runtime, scope } = await createRuntimeFixture({
      batchIntervalMs,
      submitIntervalMs: 1000,
    });

    try {
      const acceptedBatches: BatchEvent[] = [];

      const program = Effect.gen(function* () {
        const unsubscribe = yield* runtime.on("batch", (event) => {
          if (event.status === "accepted") acceptedBatches.push(event);
        });
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => unsubscribe()),
        );

        const executeFiber = yield* Effect.forkChild(
          runtime.execute(signedAdd({ address, amount: 7n, nonce: 0n })),
        );

        const earlyExit = yield* Fiber.await(executeFiber).pipe(
          Effect.timeoutOption(`${batchIntervalMs / 2} millis`),
        );
        expect(earlyExit._tag).toBe("None");

        const result = yield* Fiber.join(executeFiber);
        expect(result).toEqual({ id: 0, resolution: undefined });
        expect(acceptedBatches).toHaveLength(1);
        expect(acceptedBatches[0]!.mutations).toHaveLength(1);
        expect(acceptedBatches[0]!.forceIncludedMutations ?? []).toHaveLength(
          0,
        );
      });

      await Effect.runPromise(
        Effect.raceFirst(
          program,
          runtime.program.pipe(
            Effect.andThen(
              Effect.fail(new Error("runtime program completed unexpectedly")),
            ),
          ),
        ) as Effect.Effect<void, unknown, never>,
      );
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);

test(
  "Batch runtime accepts queued mutations in one batch",
  async () => {
    const { address, runtime, scope } = await createRuntimeFixture({
      batchIntervalMs: 200,
      submitIntervalMs: 1000,
    });

    try {
      const acceptedBatches: BatchEvent[] = [];

      const program = Effect.gen(function* () {
        const unsubscribe = yield* runtime.on("batch", (event) => {
          if (event.status === "accepted") acceptedBatches.push(event);
        });
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => unsubscribe()),
        );

        const results = yield* Effect.all(
          [
            runtime.execute(signedAdd({ address, amount: 5n, nonce: 0n })),
            runtime.execute(signedAdd({ address, amount: 7n, nonce: 1n })),
          ],
          { concurrency: "unbounded" },
        );

        expect(results).toEqual([
          { id: 0, resolution: undefined },
          { id: 1, resolution: undefined },
        ]);
        expect(acceptedBatches).toHaveLength(1);
        expect(acceptedBatches[0]!.id).toBe(0);
        expect(
          acceptedBatches[0]!.mutations.map((mutation) => mutation.id),
        ).toEqual([0, 1]);
        expect(acceptedBatches[0]!.forceIncludedMutations ?? []).toHaveLength(
          0,
        );
      });

      await Effect.runPromise(
        Effect.raceFirst(
          program,
          runtime.program.pipe(
            Effect.andThen(
              Effect.fail(new Error("runtime program completed unexpectedly")),
            ),
          ),
        ) as Effect.Effect<void, unknown, never>,
      );
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);
