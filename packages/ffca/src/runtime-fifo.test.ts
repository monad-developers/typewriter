import { expect, test } from "bun:test";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
} from "effect";
import type { Address, EIP1474Methods } from "viem";
import { createWalletClient, getAbiItem, http, toEventSelector } from "viem";
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
import { encodeMutationCalldata } from "./encoding";
import { migrate } from "./migrate";
import {
  type EffectEip1193RequestFn,
  layerRpcLive,
  makeHttpRpcRequest,
  Rpc,
} from "./rpc";
import { createRuntimeFIFOEffect } from "./runtime-fifo";
import { createMutationSchema } from "./schema";
import { layerWatchLive } from "./watch";

function createCounterConfig(address: Address, submitIntervalMs = 50) {
  return {
    address,
    domain: COUNTER_DOMAIN,
    abi: COUNTER_ABI,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo", submitIntervalMs },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;
}

function layerRpcWithMissingBlocks() {
  const request = makeHttpRpcRequest(TEST_RPC_URL);
  const requestWithMissingBlocks = ((args: {
    readonly method: string;
    readonly params?: unknown;
  }) => {
    if (args.method === "eth_getBlockByHash") {
      return Effect.succeed(null) as ReturnType<typeof request>;
    }
    return request(args as never);
  }) as EffectEip1193RequestFn<EIP1474Methods>;

  return Layer.succeed(Rpc)(Rpc.of({ request: requestWithMissingBlocks }));
}

async function createRuntimeFixture(
  options: {
    readonly rpcBlockNotFound?: boolean;
    readonly submitIntervalMs?: number;
  } = {},
) {
  const address = await deployCounter(USER_ACCOUNT.address);
  const code = await TEST_PUBLIC_CLIENT.getCode({ address });
  if (code === undefined || code === "0x") {
    throw new Error(`no contract code at ${address}`);
  }

  const config = createCounterConfig(address, options.submitIntervalMs);
  const scope = Effect.runSync(Scope.make());

  try {
    const rpcLayer = options.rpcBlockNotFound
      ? layerRpcWithMissingBlocks()
      : layerRpcLive({ rpcUrl: TEST_RPC_URL });
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

        return yield* createRuntimeFIFOEffect(config, schema).pipe(
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

test(
  "FIFO runtime submits a mutation",
  async () => {
    const { address, runtime, scope } = await createRuntimeFixture();

    const program = Effect.gen(function* () {
      const testProgram = Effect.gen(function* () {
        const included = yield* Deferred.make<void, Error>();
        const unsubscribe = yield* runtime.on("mutation", (event) => {
          if (event.status !== "included") return;
          void Effect.runSync(Deferred.succeed(included, undefined));
        });
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => unsubscribe()),
        );

        yield* runtime.execute({
          name: "add",
          args: { amount: 7n, nonce: 0n },
          signature: signCounter({
            privateKey: USER_PRIVATE_KEY,
            amount: 7n,
            nonce: 0n,
            address,
            chainId: anvil.id,
          }),
        });

        yield* Deferred.await(included);
      });

      yield* Effect.raceFirst(
        testProgram,
        runtime.program.pipe(
          Effect.andThen(
            Effect.fail(new Error("runtime program completed unexpectedly")),
          ),
        ),
      );
    });

    try {
      await Effect.runPromise(program as Effect.Effect<void, unknown, never>);

      const state = (await TEST_PUBLIC_CLIENT.readContract({
        abi: COUNTER_ABI,
        address,
        functionName: "state",
      })) as [bigint, bigint];

      expect(state).toEqual([7n, 1n]);
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);

test(
  "FIFO runtime includes an onchain force-inclusion enqueue",
  async () => {
    const { address, runtime, scope } = await createRuntimeFixture();
    const amount = 5n;
    const nonce = 0n;
    const signature = signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount,
      nonce,
      address,
      chainId: anvil.id,
    });
    const mutationData = encodeMutationCalldata({
      id: 0,
      status: "accepted",
      name: "add",
      args: { amount, nonce },
      signature,
      journalId: 0,
      isForceInclusion: true,
      queueIndex: 0n,
      config: COUNTER_MUTATIONS.add,
    });
    const userWalletClient = createWalletClient({
      account: USER_ACCOUNT,
      chain: anvil,
      transport: http(TEST_RPC_URL),
    });

    const program = Effect.gen(function* () {
      const testProgram = Effect.gen(function* () {
        const included = yield* Deferred.make<void, Error>();
        const unsubscribe = yield* runtime.on("mutation", (event) => {
          if (event.status !== "included") return;
          if (event.isForceInclusion !== true) return;
          void Effect.runSync(Deferred.succeed(included, undefined));
        });
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => unsubscribe()),
        );

        yield* Effect.promise(() =>
          userWalletClient.writeContract({
            account: USER_ACCOUNT,
            chain: anvil,
            address,
            abi: COUNTER_ABI,
            functionName: "enqueue",
            args: [COUNTER_MUTATIONS.add.tag, mutationData, signature],
          }),
        );

        yield* Effect.raceFirst(
          Deferred.await(included),
          Effect.sleep(Duration.seconds(8)).pipe(
            Effect.andThen(
              Effect.fail(new Error("force inclusion was not included")),
            ),
          ),
        );
      });

      yield* Effect.raceFirst(
        testProgram,
        runtime.program.pipe(
          Effect.andThen(
            Effect.fail(new Error("runtime program completed unexpectedly")),
          ),
        ),
      );
    });

    try {
      await Effect.runPromise(program as Effect.Effect<void, unknown, never>);

      const state = (await TEST_PUBLIC_CLIENT.readContract({
        abi: COUNTER_ABI,
        address,
        functionName: "state",
      })) as [bigint, bigint];

      expect(state).toEqual([amount, 1n]);
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);

test(
  "FIFO runtime delays force inclusion behind already accepted mutations",
  async () => {
    const { address, runtime, scope } = await createRuntimeFixture();
    const acceptedAmount = 7n;
    const forceIncludedAmount = 5n;
    const forceIncludedSignature = signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: forceIncludedAmount,
      nonce: 1n,
      address,
      chainId: anvil.id,
    });
    const mutationData = encodeMutationCalldata({
      id: 0,
      status: "accepted",
      name: "add",
      args: { amount: forceIncludedAmount, nonce: 1n },
      signature: forceIncludedSignature,
      journalId: 0,
      isForceInclusion: true,
      queueIndex: 0n,
      config: COUNTER_MUTATIONS.add,
    });
    const userWalletClient = createWalletClient({
      account: USER_ACCOUNT,
      chain: anvil,
      transport: http(TEST_RPC_URL),
    });

    const program = Effect.gen(function* () {
      const included = yield* Deferred.make<void, Error>();
      const includedBlockMutations: boolean[][] = [];
      const unsubscribe = yield* runtime.on("block", (event) => {
        if (event.status !== "included") return;
        includedBlockMutations.push(
          event.mutations.map((mutation) =>
            "isForceInclusion" in mutation ? mutation.isForceInclusion : false,
          ),
        );
        if (includedBlockMutations.length === 2) {
          void Effect.runSync(Deferred.succeed(included, undefined));
        }
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => unsubscribe()),
      );

      yield* Effect.sleep(Duration.millis(500));

      yield* runtime.execute({
        name: "add",
        args: { amount: acceptedAmount, nonce: 0n },
        signature: signCounter({
          privateKey: USER_PRIVATE_KEY,
          amount: acceptedAmount,
          nonce: 0n,
          address,
          chainId: anvil.id,
        }),
      });

      yield* Effect.promise(() =>
        userWalletClient.writeContract({
          account: USER_ACCOUNT,
          chain: anvil,
          address,
          abi: COUNTER_ABI,
          functionName: "enqueue",
          args: [
            COUNTER_MUTATIONS.add.tag,
            mutationData,
            forceIncludedSignature,
          ],
        }),
      );

      yield* Effect.sleep(Duration.millis(500));

      yield* Effect.raceFirst(
        Effect.raceFirst(
          Deferred.await(included),
          Effect.sleep(Duration.seconds(8)).pipe(
            Effect.andThen(
              Effect.fail(
                new Error("force inclusion was not included in a later block"),
              ),
            ),
          ),
        ),
        runtime.program.pipe(
          Effect.andThen(
            Effect.fail(new Error("runtime program completed unexpectedly")),
          ),
        ),
      );

      expect(includedBlockMutations).toEqual([[false], [true]]);
    });

    try {
      await Effect.runPromise(program as Effect.Effect<void, unknown, never>);

      const state = (await TEST_PUBLIC_CLIENT.readContract({
        abi: COUNTER_ABI,
        address,
        functionName: "state",
      })) as [bigint, bigint];

      expect(state).toEqual([acceptedAmount + forceIncludedAmount, 2n]);
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);

test(
  "FIFO runtime handles failing mutation",
  async () => {
    const { address, runtime, scope } = await createRuntimeFixture();

    try {
      const statuses: string[] = [];
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const unsubscribe = yield* runtime.on("mutation", (event) => {
            statuses.push(event.status);
          });
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => unsubscribe()),
          );

          return yield* Effect.exit(
            runtime.execute({
              name: "add",
              args: { amount: 7n, nonce: 1n },
              signature: signCounter({
                privateKey: USER_PRIVATE_KEY,
                amount: 7n,
                nonce: 1n,
                address,
                chainId: anvil.id,
              }),
            }),
          );
        }) as Effect.Effect<Exit.Exit<unknown, unknown>, never, never>,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(statuses).toEqual(["received", "rejected"]);

      const state = (await TEST_PUBLIC_CLIENT.readContract({
        abi: COUNTER_ABI,
        address,
        functionName: "state",
      })) as [bigint, bigint];
      expect(state).toEqual([0n, 0n]);
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);

test(
  "FIFO runtime program surfaces submit failure",
  async () => {
    const { address, runtime, scope } = await createRuntimeFixture({
      rpcBlockNotFound: true,
    });

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* runtime.execute({
            name: "add",
            args: { amount: 7n, nonce: 0n },
            signature: signCounter({
              privateKey: USER_PRIVATE_KEY,
              amount: 7n,
              nonce: 0n,
              address,
              chainId: anvil.id,
            }),
          });

          return yield* Effect.raceFirst(
            runtime.program.pipe(
              Effect.exit,
              Effect.map((exit) => ({ _tag: "exit" as const, exit })),
            ),
            Effect.sleep(Duration.seconds(5)).pipe(
              Effect.as({ _tag: "timeout" as const }),
            ),
          );
        }) as Effect.Effect<
          | {
              readonly _tag: "exit";
              readonly exit: Exit.Exit<unknown, unknown>;
            }
          | { readonly _tag: "timeout" },
          never,
          never
        >,
      );

      expect(result._tag).toBe("exit");
      if (result._tag === "exit") {
        expect(Exit.isFailure(result.exit)).toBe(true);
      }
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);

test(
  "FIFO runtime program handles interrupt",
  async () => {
    const { runtime, scope } = await createRuntimeFixture();

    try {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(runtime.program);
          yield* Effect.sleep(Duration.millis(25));
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }) as Effect.Effect<Exit.Exit<unknown, unknown>, never, never>,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
    } finally {
      await closeScope(scope);
    }
  },
  { timeout: 20000 },
);
