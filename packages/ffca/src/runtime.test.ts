import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Cause, Effect, Exit, Fiber, Layer, Schedule, Scope } from "effect";
import {
  type Address,
  createWalletClient,
  getAbiItem,
  http,
  toEventSelector,
} from "viem";
import { anvil } from "viem/chains";
import Counter from "../test/contracts/src/Counter.sol";
import Harness from "../test/contracts/src/Harness.sol";
import {
  ALICE_ACCOUNT,
  ALICE_PRIVATE_KEY,
  P256_PRIVATE_KEY,
  SCHEDULER_ACCOUNT,
  TEST_DB_CONNECTION,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  counterNewAccountMutation,
  deployCounter,
  deployHarness,
  encodeHarnessSignature,
  harnessAccountId,
  p256PublicKey,
  readContractStorage,
  secp256k1PublicKey,
  signCounter,
  signHarness,
} from "../test/utils";
import { layerDatabaseLive } from "./db";
import {
  encodeMutationCalldata,
  encodeSignatureCalldata,
  FFCA_ABI,
} from "./encoding";
import type { InternalRuntimeFFCA } from "./ffca";
import type { InternalApp } from "./internal";
import { deploymentSchemaName, migrate } from "./migrate";
import { layerRpcLive } from "./rpc";
import { createRuntimeEffect as createRuntimeBatchEffectInternal } from "./runtime";
import { loadSolidityFFCAApp } from "./sol-parse";
import { layerWatchLive } from "./watch";

function layerRuntimeServices(address: Address) {
  const rpcLayer = layerRpcLive({ rpcUrls: [TEST_RPC_URL] });
  const dbLayer = layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 });
  const forceInclusionEvent = getAbiItem({
    abi: FFCA_ABI,
    name: "ForceInclusionQueued",
  });
  if (forceInclusionEvent === undefined) {
    throw new Error("missing FFCA ForceInclusionQueued event");
  }
  const watchLayer = layerWatchLive({
    pollIntervalMs: 200,
    maxChainDepth: 5,
    logFilter: {
      address,
      selector: toEventSelector(forceInclusionEvent),
    },
  }).pipe(Layer.provide(rpcLayer));

  return rpcLayer.pipe(Layer.merge(dbLayer), Layer.merge(watchLayer));
}

function createRuntimeBatchEffect(
  app: InternalApp,
  schema: InternalApp["schema"] = app.schema,
) {
  return createRuntimeBatchEffectInternal({
    ...app,
    schema,
  });
}

function requiredTable<
  Schema extends Record<string, unknown>,
  Name extends keyof Schema,
>(schema: Schema, name: Name): Exclude<Schema[Name], undefined> {
  const table = schema[name];
  if (table === undefined) {
    throw new Error(`table missing: ${String(name)}`);
  }
  return table as Exclude<Schema[Name], undefined>;
}

function harnessSignature(params: {
  readonly account: `0x${string}`;
  readonly keyId: bigint;
  readonly keyType: number;
  readonly rawSignature: `0x${string}`;
}) {
  return encodeHarnessSignature(params);
}

function signHarnessMutation(params: {
  readonly address: Address;
  readonly account: `0x${string}`;
  readonly keyId: bigint;
  readonly keyType: number;
  readonly privateKey: `0x${string}`;
  readonly mutation: "Authorize" | "Credit" | "Debit" | "Assert";
  readonly params: Record<string, unknown>;
}) {
  return harnessSignature({
    account: params.account,
    keyId: params.keyId,
    keyType: params.keyType,
    rawSignature: signHarness({
      keyType: params.keyType,
      privateKey: params.privateKey,
      mutation: params.mutation,
      params: params.params,
      address: params.address,
      chainId: anvil.id,
    }),
  });
}

test("createRuntimeBatchEffect", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* runtime.program
      .pipe(Effect.timeoutOption("1 seconds"), Effect.asVoid)
      .pipe(Effect.tapError((error) => Effect.sync(() => console.log(error))));
  });

  await Effect.runPromise(program);
});

test("runtime loads persisted slot state before returning", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);
  const schemaName = deploymentSchemaName(anvil.id, address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    yield* Effect.promise(
      () => TEST_DB_CONNECTION`
      INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.add_mutations
        (id, status, amount, nonce, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
      VALUES
        (0, 'included', 7, 0, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
    `,
    );
    yield* Effect.promise(
      () => TEST_DB_CONNECTION`
      INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.slot_writes
        (${TEST_DB_CONNECTION("mutationId")}, slot, value)
      VALUES
        (0, ${"0x0000000000000000000000000000000000000000000000000000000000000002"}, ${"0x0000000000000000000000000000000000000000000000000000000000000007"})
    `,
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );
    const state = runtime.state as {
      total: Promise<bigint>;
    };

    return {
      total: yield* Effect.promise(() => state.total),
    };
  });

  await expect(Effect.runPromise(program)).resolves.toEqual({
    total: 7n,
  });
});

test("execute() returns an accepted mutation", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const runtimeFiber = yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    const mutationResult = yield* runtime.execute({
      name: "Add",
      params: { amount: 7n, nonce: 0n },
      signature: signCounter({
        privateKey: USER_PRIVATE_KEY,
        amount: 7n,
        nonce: 0n,
        address,
        chainId: anvil.id,
      }),
    });

    yield* Fiber.interrupt(runtimeFiber);

    return mutationResult;
  });

  const mutationResult = await Effect.runPromise(program);

  expect(mutationResult).toMatchInlineSnapshot(`
    {
      "id": 1,
    }
  `);
});

test("execute() accepts multiple mutations in a batch", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    const mutationResults = [];
    for (const { amount, nonce } of [
      { amount: 5n, nonce: 0n },
      { amount: 7n, nonce: 1n },
      { amount: 11n, nonce: 2n },
    ]) {
      mutationResults.push(
        yield* runtime.execute({
          name: "Add",
          params: { amount, nonce },
          signature: signCounter({
            privateKey: USER_PRIVATE_KEY,
            amount,
            nonce,
            address,
            chainId: anvil.id,
          }),
        }),
      );
    }

    return mutationResults;
  });

  const mutationResults = await Effect.runPromise(program);

  expect(mutationResults).toMatchInlineSnapshot(`
    [
      {
        "id": 1,
      },
      {
        "id": 2,
      },
      {
        "id": 3,
      },
    ]
  `);
});

test("runtime emits mutation, batch, and block events", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);
  const events: unknown[] = [];

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const included = Promise.withResolvers<void>();

    const unsubscribeMutation = yield* runtime.on("mutation", (event) => {
      events.push({
        event: "mutation",
        id: event.id,
        status: event.status,
        name: event.name,
        isForceInclusion:
          "isForceInclusion" in event ? event.isForceInclusion : undefined,
      });
      if (event.status === "included" && event.name === "Add") {
        included.resolve();
      }
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeMutation));

    const batchRuntime = runtime as InternalRuntimeFFCA<"batch">;

    const unsubscribeBatch = yield* batchRuntime.on("batch", (event) => {
      events.push({
        event: "batch",
        id: event.id,
        status: event.status,
        mutationIds: event.mutations.map((mutation) => mutation.id),
      });
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeBatch));

    const unsubscribeBlock = yield* batchRuntime.on("block", (event) => {
      events.push({
        event: "block",
        status: event.status,
        batchIds: event.batches.map((batch) => batch.id),
      });
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeBlock));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    yield* runtime.execute({
      name: "Add",
      params: { amount: 7n, nonce: 0n },
      signature: signCounter({
        privateKey: USER_PRIVATE_KEY,
        amount: 7n,
        nonce: 0n,
        address,
        chainId: anvil.id,
      }),
    });

    yield* Effect.promise(() => included.promise);
  });

  await Effect.runPromise(program);

  expect(events).toMatchInlineSnapshot(`
    [
      {
        "event": "mutation",
        "id": 0,
        "isForceInclusion": undefined,
        "name": "NewAccount",
        "status": "received",
      },
      {
        "event": "mutation",
        "id": 0,
        "isForceInclusion": false,
        "name": "NewAccount",
        "status": "accepted",
      },
      {
        "event": "batch",
        "id": 0,
        "mutationIds": [
          0,
        ],
        "status": "accepted",
      },
      {
        "event": "mutation",
        "id": 1,
        "isForceInclusion": undefined,
        "name": "Add",
        "status": "received",
      },
      {
        "event": "mutation",
        "id": 1,
        "isForceInclusion": false,
        "name": "Add",
        "status": "accepted",
      },
      {
        "event": "batch",
        "id": 1,
        "mutationIds": [
          1,
        ],
        "status": "accepted",
      },
      {
        "batchIds": [
          0,
          1,
        ],
        "event": "block",
        "status": "included",
      },
      {
        "event": "batch",
        "id": 0,
        "mutationIds": [
          0,
        ],
        "status": "included",
      },
      {
        "event": "mutation",
        "id": 0,
        "isForceInclusion": false,
        "name": "NewAccount",
        "status": "included",
      },
      {
        "event": "batch",
        "id": 1,
        "mutationIds": [
          1,
        ],
        "status": "included",
      },
      {
        "event": "mutation",
        "id": 1,
        "isForceInclusion": false,
        "name": "Add",
        "status": "included",
      },
    ]
  `);
});

test("runtime persists mutations to database", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);
  const db = drizzle({ client: TEST_DB_CONNECTION });
  const addMutations = requiredTable(schema, "add_mutations");

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    yield* runtime.execute({
      name: "Add",
      params: { amount: 7n, nonce: 0n },
      signature: signCounter({
        privateKey: USER_PRIVATE_KEY,
        amount: 7n,
        nonce: 0n,
        address,
        chainId: anvil.id,
      }),
    });

    yield* Effect.tryPromise(() => db.select().from(addMutations)).pipe(
      Effect.flatMap((rows) =>
        rows.length > 0
          ? Effect.succeed(rows)
          : Effect.fail(new Error("mutation not persisted yet")),
      ),
      Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
    );
  });

  await Effect.runPromise(program);

  const addMutationRows = (await db.select().from(addMutations)) as unknown as {
    id: number;
    status: string;
    amount: bigint;
    nonce: bigint;
    signature_rawSignature: `0x${string}`;
  }[];
  const mutationRows = addMutationRows.map(
    ({ id, status, amount, nonce, signature_rawSignature }) => ({
      id,
      status,
      amount,
      nonce,
      has_signature: signature_rawSignature.startsWith("0x"),
    }),
  );
  const slotRows = await db
    .select({
      mutationId: schema.slot_writes.mutationId,
      slot: schema.slot_writes.slot,
      value: schema.slot_writes.value,
    })
    .from(schema.slot_writes)
    .orderBy(schema.slot_writes.slot, schema.slot_writes.mutationId);

  expect(mutationRows).toMatchInlineSnapshot(`
    [
      {
        "amount": 7n,
        "has_signature": true,
        "id": 1,
        "nonce": 0n,
        "status": "accepted",
      },
    ]
  `);
  expect(slotRows).toMatchInlineSnapshot(`
    [
      {
        "mutationId": 0,
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
      {
        "mutationId": 1,
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000002",
      },
      {
        "mutationId": 1,
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000002",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000007",
      },
      {
        "mutationId": 0,
        "slot": "0x4b34b6d94765684e75e2287a756838f958648a9e09745d6f59261d2605c63349",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000002",
      },
      {
        "mutationId": 0,
        "slot": "0x4b34b6d94765684e75e2287a756838f958648a9e09745d6f59261d2605c6334a",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000041",
      },
      {
        "mutationId": 1,
        "slot": "0x4b34b6d94765684e75e2287a756838f958648a9e09745d6f59261d2605c6334b",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
      {
        "mutationId": 0,
        "slot": "0x7219189c07c0f389dfd1501044939ed0dc585059dc8f86641b63920b63f92dc7",
        "value": "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
      },
    ]
  `);
});

test("runtime submits a mutation onchain", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const pwr = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "included" && event.name === "Add") pwr.resolve();
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    yield* runtime.execute({
      name: "Add",
      params: { amount: 7n, nonce: 0n },
      signature: signCounter({
        privateKey: USER_PRIVATE_KEY,
        amount: 7n,
        nonce: 0n,
        address,
        chainId: anvil.id,
      }),
    });

    yield* Effect.promise(() => pwr.promise);
  });

  await Effect.runPromise(program);

  expect(await readContractStorage(app.storageLayout, address, "total")).toBe(
    7n,
  );
});

test("runtime finalizes a mutation", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const pwr = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "finalized" && event.name === "Add") pwr.resolve();
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    yield* runtime.execute({
      name: "Add",
      params: { amount: 7n, nonce: 0n },
      signature: signCounter({
        privateKey: USER_PRIVATE_KEY,
        amount: 7n,
        nonce: 0n,
        address,
        chainId: anvil.id,
      }),
    });

    yield* Effect.promise(() => pwr.promise);
  });

  await Effect.runPromise(program);
});

test("runtime reorders Harness mutations by batch order", async () => {
  const address = await deployHarness();
  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const account = harnessAccountId(rootPublicKey);

  const app = await loadSolidityFFCAApp(Harness, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder: ["Initialize", "Credit", "Debit"],
    },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute({
      name: "Initialize",
      params: { rootKeyType: 2, rootPublicKey },
      signature: harnessSignature({
        account,
        keyId: 0n,
        keyType: 2,
        rawSignature: "0x",
      }),
    });

    const creditArgs = { account, keyId: 0n, amount: 100n, nonce: 0n };
    const debitArgs = { account, keyId: 0n, amount: 30n, nonce: 1n };
    yield* Effect.all(
      [
        runtime.execute({
          name: "Debit",
          params: debitArgs,
          signature: signHarnessMutation({
            address,
            account,
            keyId: 0n,
            keyType: 2,
            privateKey: ALICE_PRIVATE_KEY,
            mutation: "Debit",
            params: debitArgs,
          }),
        }),
        runtime.execute({
          name: "Credit",
          params: creditArgs,
          signature: signHarnessMutation({
            address,
            account,
            keyId: 0n,
            keyType: 2,
            privateKey: ALICE_PRIVATE_KEY,
            mutation: "Credit",
            params: creditArgs,
          }),
        }),
      ],
      { concurrency: "unbounded" },
    );

    const state = runtime.state as unknown as {
      readonly balances: { readonly [key: `0x${string}`]: Promise<bigint> };
    };
    return yield* Effect.promise(() => state.balances[account]!);
  });

  await expect(Effect.runPromise(program)).resolves.toBe(70n);
});

test("fifo runtime preserves submission order without batch reordering", async () => {
  const address = await deployHarness();
  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const account = harnessAccountId(rootPublicKey);

  const app = await loadSolidityFFCAApp(Harness, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo", submitIntervalMs: 3_600_000 },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const initializeFiber = yield* Effect.forkChild(
      runtime.execute({
        name: "Initialize",
        params: { rootKeyType: 2, rootPublicKey },
        signature: harnessSignature({
          account,
          keyId: 0n,
          keyType: 2,
          rawSignature: "0x",
        }),
      }),
    );
    yield* Effect.sleep("1 millis");

    const debitArgs = { account, keyId: 0n, amount: 30n, nonce: 1n };
    const debitFiber = yield* Effect.forkChild(
      runtime.execute({
        name: "Debit",
        params: debitArgs,
        signature: signHarnessMutation({
          address,
          account,
          keyId: 0n,
          keyType: 2,
          privateKey: ALICE_PRIVATE_KEY,
          mutation: "Debit",
          params: debitArgs,
        }),
      }),
    );
    yield* Effect.sleep("1 millis");

    const creditArgs = { account, keyId: 0n, amount: 100n, nonce: 0n };
    const creditFiber = yield* Effect.forkChild(
      runtime.execute({
        name: "Credit",
        params: creditArgs,
        signature: signHarnessMutation({
          address,
          account,
          keyId: 0n,
          keyType: 2,
          privateKey: ALICE_PRIVATE_KEY,
          mutation: "Credit",
          params: creditArgs,
        }),
      }),
    );
    yield* Effect.sleep("1 millis");

    const runtimeFiber = yield* Effect.forkChild(runtime.program);
    const initializeExit = yield* Fiber.await(initializeFiber);
    const debitExit = yield* Fiber.await(debitFiber);
    const creditExit = yield* Fiber.await(creditFiber);
    yield* Fiber.interrupt(runtimeFiber);

    const state = runtime.state as unknown as {
      readonly balances: { readonly [key: `0x${string}`]: Promise<bigint> };
    };
    return {
      initializeSucceeded: Exit.isSuccess(initializeExit),
      debitFailed: Exit.isFailure(debitExit),
      creditSucceeded: Exit.isSuccess(creditExit),
      balance: yield* Effect.promise(() => state.balances[account]!),
    };
  });

  await expect(Effect.runPromise(program)).resolves.toMatchInlineSnapshot(`
    {
      "balance": 100n,
      "creditSucceeded": true,
      "debitFailed": true,
      "initializeSucceeded": true,
    }
  `);
});

test("runtime rejects a Harness mutation when onchain execution reverts", async () => {
  const address = await deployHarness();
  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const account = harnessAccountId(rootPublicKey);

  const app = await loadSolidityFFCAApp(Harness, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["Initialize", "Debit"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute({
      name: "Initialize",
      params: { rootKeyType: 2, rootPublicKey },
      signature: harnessSignature({
        account,
        keyId: 0n,
        keyType: 2,
        rawSignature: "0x",
      }),
    });

    const debitArgs = { account, keyId: 0n, amount: 30n, nonce: 0n };
    return yield* Effect.exit(
      runtime.execute({
        name: "Debit",
        params: debitArgs,
        signature: signHarnessMutation({
          address,
          account,
          keyId: 0n,
          keyType: 2,
          privateKey: ALICE_PRIVATE_KEY,
          mutation: "Debit",
          params: debitArgs,
        }),
      }),
    );
  });

  const exit = await Effect.runPromise(program);

  expect(Exit.isFailure(exit)).toBe(true);
});

test("runtime handles Harness account management with multiple signature types", async () => {
  const address = await deployHarness();
  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const p256Pk = p256PublicKey(P256_PRIVATE_KEY);
  const account = harnessAccountId(rootPublicKey);

  const app = await loadSolidityFFCAApp(Harness, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder: ["Initialize", "Authorize", "Credit"],
    },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute({
      name: "Initialize",
      params: { rootKeyType: 2, rootPublicKey },
      signature: harnessSignature({
        account,
        keyId: 0n,
        keyType: 2,
        rawSignature: "0x",
      }),
    });

    const authorizeP256Args = {
      account,
      keyId: 1n,
      keyType: 0,
      publicKey: p256Pk,
      nonce: 0n,
    };
    yield* runtime.execute({
      name: "Authorize",
      params: authorizeP256Args,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 0n,
        keyType: 2,
        privateKey: ALICE_PRIVATE_KEY,
        mutation: "Authorize",
        params: authorizeP256Args,
      }),
    });

    const p256CreditArgs = {
      account,
      keyId: 1n,
      amount: 100n,
      nonce: 1n,
    };
    yield* runtime.execute({
      name: "Credit",
      params: p256CreditArgs,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 1n,
        keyType: 0,
        privateKey: P256_PRIVATE_KEY,
        mutation: "Credit",
        params: p256CreditArgs,
      }),
    });

    const authorizeWebAuthnArgs = {
      account,
      keyId: 2n,
      keyType: 1,
      publicKey: p256Pk,
      nonce: 2n,
    };
    yield* runtime.execute({
      name: "Authorize",
      params: authorizeWebAuthnArgs,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 1n,
        keyType: 0,
        privateKey: P256_PRIVATE_KEY,
        mutation: "Authorize",
        params: authorizeWebAuthnArgs,
      }),
    });

    const webAuthnCreditArgs = {
      account,
      keyId: 2n,
      amount: 50n,
      nonce: 3n,
    };
    yield* runtime.execute({
      name: "Credit",
      params: webAuthnCreditArgs,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 2n,
        keyType: 1,
        privateKey: P256_PRIVATE_KEY,
        mutation: "Credit",
        params: webAuthnCreditArgs,
      }),
    });

    const state = runtime.state as unknown as {
      readonly balances: { readonly [key: `0x${string}`]: Promise<bigint> };
    };
    return yield* Effect.promise(() => state.balances[account]!);
  });

  await expect(Effect.runPromise(program)).resolves.toBe(150n);
});

test("runtime includes an onchain force-inclusion enqueue", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const amount = 5n;
  const nonce = 0n;
  const signature = signCounter({
    privateKey: USER_PRIVATE_KEY,
    amount,
    nonce,
    address,
    chainId: anvil.id,
  });

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });
  const { Add: addMutation } = app.mutations;
  if (addMutation === undefined) {
    throw new Error("Counter app missing Add mutation");
  }

  const mutationData = encodeMutationCalldata({
    id: 0,
    status: "accepted",
    name: "Add",
    params: { amount, nonce },
    signature,
    journalId: 0,
    isForceInclusion: false,
    config: addMutation,
  });
  const userWalletClient = createWalletClient({
    account: USER_ACCOUNT,
    chain: anvil,
    transport: http(TEST_RPC_URL),
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const setupIncluded = Promise.withResolvers<void>();
    const pwr = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "included" && event.name === "NewAccount") {
        setupIncluded.resolve();
      }
      if (event.status === "included" && event.isForceInclusion) {
        pwr.resolve();
      }
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );
    yield* Effect.promise(() => setupIncluded.promise);

    yield* Effect.promise(() =>
      userWalletClient.writeContract({
        account: USER_ACCOUNT,
        chain: anvil,
        address,
        abi: FFCA_ABI,
        functionName: "enqueue",
        args: [
          addMutation.tag,
          mutationData,
          encodeSignatureCalldata(app.signature.params, signature),
        ],
      }),
    );

    yield* Effect.promise(() => pwr.promise);
  });

  await Effect.runPromise(program);

  expect(await readContractStorage(app.storageLayout, address, "total")).toBe(
    amount,
  );
});

test("runtime handles failing mutation", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["NewAccount", "Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    return yield* Effect.exit(
      runtime.execute({
        name: "Add",
        params: { amount: 7n, nonce: 1n },
        signature: signCounter({
          privateKey: USER_PRIVATE_KEY,
          amount: 7n,
          nonce: 1n,
          address,
          chainId: anvil.id,
        }),
      }),
    );
  });

  const exit = await Effect.runPromise(program);

  expect(Exit.isFailure(exit)).toBe(true);
  expect(await readContractStorage(app.storageLayout, address, "total")).toBe(
    0n,
  );
});

test("runtime program handles interrupt", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const app = await loadSolidityFFCAApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "batch", batchOrder: ["Add"] },
    database: { url: TEST_DB_URL, maxConnections: 1 },
  });

  const schema = app.schema;
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, app.chainId, app.address, 0n).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeBatchEffect(app, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const fiber = yield* Effect.forkChild(runtime.program);
    yield* Effect.sleep("25 millis");
    yield* Fiber.interrupt(fiber);
    return yield* Fiber.await(fiber);
  });

  const exit = await Effect.runPromise(program);

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }
});
