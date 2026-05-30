import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect";
import type { Address } from "viem";
import { createWalletClient, getAbiItem, http, toEventSelector } from "viem";
import { anvil } from "viem/chains";
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
  COUNTER_DOMAIN,
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  COUNTER_STORAGE_LAYOUT,
  counterNewAccountMutation,
  deployCounter,
  deployHarness,
  encodeHarnessSignature,
  HARNESS_DOMAIN,
  HARNESS_MUTATIONS,
  HARNESS_SIGNATURE_PARAMS,
  HARNESS_STORAGE_LAYOUT,
  harnessAccountId,
  p256PublicKey,
  readContractStorage,
  secp256k1PublicKey,
  signCounter,
  signHarness,
} from "../test/utils";
import { buildInternalApp, type FFCAConfig } from "./config";
import { layerDatabaseLive } from "./db";
import {
  encodeMutationCalldata,
  encodeSignatureCalldata,
  FFCA_ABI,
} from "./encoding";
import { deploymentSchemaName, migrate } from "./migrate";
import { layerRpcLive } from "./rpc";
import { createRuntimeFIFOEffect as createRuntimeFIFOEffectInternal } from "./runtime-fifo";
import { createMutationSchema } from "./schema";
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

function createRuntimeFIFOEffect(
  config: FFCAConfig,
  schema: ReturnType<typeof createMutationSchema>,
) {
  return createRuntimeFIFOEffectInternal({
    ...buildInternalApp(config),
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
  readonly mutation: "authorize" | "credit" | "debit" | "assert";
  readonly args: Record<string, unknown>;
}) {
  return harnessSignature({
    account: params.account,
    keyId: params.keyId,
    keyType: params.keyType,
    rawSignature: signHarness({
      keyType: params.keyType,
      privateKey: params.privateKey,
      mutation: params.mutation,
      args: params.args,
      address: params.address,
      chainId: anvil.id,
    }),
  });
}

test("createRuntimeFIFOEffect", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
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

  const config = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);
  const schemaName = deploymentSchemaName(anvil.id, address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
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
        (0, ${"0x0000000000000000000000000000000000000000000000000000000000000001"}, ${"0x0000000000000000000000000000000000000000000000000000000000000007"})
    `,
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
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

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );

    const mutationResult = yield* runtime.execute({
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

    return mutationResult;
  });

  const mutationResult = await Effect.runPromise(program);

  expect(mutationResult).toMatchInlineSnapshot(`
    {
      "id": 1,
      "resolution": undefined,
    }
  `);
});

test("execute() accepts multiple mutations", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
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
          name: "add",
          args: { amount, nonce },
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
        "resolution": undefined,
      },
      {
        "id": 2,
        "resolution": undefined,
      },
      {
        "id": 3,
        "resolution": undefined,
      },
    ]
  `);
});

test("runtime emits mutation and block events", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);
  const events: unknown[] = [];

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
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
      if (event.status === "included" && event.name === "add") {
        included.resolve();
      }
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeMutation));

    const unsubscribeBlock = yield* runtime.on("block", (event) => {
      events.push({
        event: "block",
        status: event.status,
        mutationIds: event.mutations.map((mutation) => mutation.id),
      });
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeBlock));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
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

    yield* Effect.promise(() => included.promise);
  });

  await Effect.runPromise(program);

  expect(events).toMatchInlineSnapshot(`
    [
      {
        "event": "mutation",
        "id": 0,
        "isForceInclusion": undefined,
        "name": "newAccount",
        "status": "received",
      },
      {
        "event": "mutation",
        "id": 0,
        "isForceInclusion": false,
        "name": "newAccount",
        "status": "accepted",
      },
      {
        "event": "mutation",
        "id": 1,
        "isForceInclusion": undefined,
        "name": "add",
        "status": "received",
      },
      {
        "event": "mutation",
        "id": 1,
        "isForceInclusion": false,
        "name": "add",
        "status": "accepted",
      },
      {
        "event": "block",
        "mutationIds": [
          0,
          1,
        ],
        "status": "included",
      },
      {
        "event": "mutation",
        "id": 0,
        "isForceInclusion": false,
        "name": "newAccount",
        "status": "included",
      },
      {
        "event": "mutation",
        "id": 1,
        "isForceInclusion": false,
        "name": "add",
        "status": "included",
      },
    ]
  `);
});

test("runtime persists mutations to database", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
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
  });

  await Effect.runPromise(program);

  const db = drizzle({ client: TEST_DB_CONNECTION });
  const addMutations = requiredTable(schema, "add_mutations");
  const addMutationRows = (await db.select().from(addMutations)) as {
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
    .orderBy(schema.slot_writes.slot);

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
        "mutationId": 1,
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000007",
      },
      {
        "mutationId": 0,
        "slot": "0x4d5e1cceefe7c333a82a954f09fd3c3d92bb609f28430423d579251115de6c55",
        "value": "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
      },
      {
        "mutationId": 0,
        "slot": "0x8ab7381f68a0ae9f01a74b7a3e436aeef59d866ed6b095c7f39d48c20836c133",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000002",
      },
      {
        "mutationId": 0,
        "slot": "0x8ab7381f68a0ae9f01a74b7a3e436aeef59d866ed6b095c7f39d48c20836c134",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000041",
      },
      {
        "mutationId": 1,
        "slot": "0x8ab7381f68a0ae9f01a74b7a3e436aeef59d866ed6b095c7f39d48c20836c135",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
    ]
  `);
});

test("runtime submits a mutation onchain", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const pwr = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "included" && event.name === "add") pwr.resolve();
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
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

    yield* Effect.promise(() => pwr.promise);
  });

  await Effect.runPromise(program);

  expect(
    await readContractStorage(COUNTER_STORAGE_LAYOUT, address, "total"),
  ).toBe(7n);
});

test("runtime finalizes a mutation", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const pwr = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "finalized" && event.name === "add") pwr.resolve();
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));
    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
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

    yield* Effect.promise(() => pwr.promise);
  });

  await Effect.runPromise(program);
});

test("runtime rejects a Harness mutation when resolution throws", async () => {
  const address = await deployHarness();
  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const account = harnessAccountId(rootPublicKey);

  const config: FFCAConfig = {
    address,
    domain: HARNESS_DOMAIN,
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: HARNESS_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* runtime.execute({
      name: "initialize",
      args: { rootKeyType: 2, rootPublicKey },
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
        name: "debit",
        args: debitArgs,
        signature: signHarnessMutation({
          address,
          account,
          keyId: 0n,
          keyType: 2,
          privateKey: ALICE_PRIVATE_KEY,
          mutation: "debit",
          args: debitArgs,
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

  const config: FFCAConfig = {
    address,
    domain: HARNESS_DOMAIN,
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: HARNESS_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* runtime.execute({
      name: "initialize",
      args: { rootKeyType: 2, rootPublicKey },
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
      name: "authorize",
      args: authorizeP256Args,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 0n,
        keyType: 2,
        privateKey: ALICE_PRIVATE_KEY,
        mutation: "authorize",
        args: authorizeP256Args,
      }),
    });

    const p256CreditArgs = {
      account,
      keyId: 1n,
      amount: 100n,
      nonce: 1n,
    };
    yield* runtime.execute({
      name: "credit",
      args: p256CreditArgs,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 1n,
        keyType: 0,
        privateKey: P256_PRIVATE_KEY,
        mutation: "credit",
        args: p256CreditArgs,
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
      name: "authorize",
      args: authorizeWebAuthnArgs,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 1n,
        keyType: 0,
        privateKey: P256_PRIVATE_KEY,
        mutation: "authorize",
        args: authorizeWebAuthnArgs,
      }),
    });

    const webAuthnCreditArgs = {
      account,
      keyId: 2n,
      amount: 50n,
      nonce: 3n,
    };
    yield* runtime.execute({
      name: "credit",
      args: webAuthnCreditArgs,
      signature: signHarnessMutation({
        address,
        account,
        keyId: 2n,
        keyType: 1,
        privateKey: P256_PRIVATE_KEY,
        mutation: "credit",
        args: webAuthnCreditArgs,
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
  const mutationData = encodeMutationCalldata({
    id: 0,
    status: "accepted",
    name: "add",
    args: { amount, nonce },
    signature,
    journalId: 0,
    isForceInclusion: false,
    config: COUNTER_MUTATIONS.add,
  });
  const userWalletClient = createWalletClient({
    account: USER_ACCOUNT,
    chain: anvil,
    transport: http(TEST_RPC_URL),
  });

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const setupIncluded = Promise.withResolvers<void>();
    const pwr = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "included" && event.name === "newAccount") {
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
          COUNTER_MUTATIONS.add.tag,
          mutationData,
          encodeSignatureCalldata(COUNTER_SIGNATURE_PARAMS, signature),
        ],
      }),
    );

    yield* Effect.promise(() => pwr.promise);
  });

  await Effect.runPromise(program);

  expect(
    await readContractStorage(COUNTER_STORAGE_LAYOUT, address, "total"),
  ).toBe(amount);
});

test("runtime delays force inclusion behind already accepted mutations", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
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
    isForceInclusion: false,
    config: COUNTER_MUTATIONS.add,
  });
  const userWalletClient = createWalletClient({
    account: USER_ACCOUNT,
    chain: anvil,
    transport: http(TEST_RPC_URL),
  });

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    const setupIncluded = Promise.withResolvers<void>();
    const pwr1 = Promise.withResolvers<void>();
    const pwr2 = Promise.withResolvers<void>();

    const unsubscribe = yield* runtime.on("mutation", (event) => {
      if (event.status === "included") {
        if (event.name === "newAccount") setupIncluded.resolve();
        if (event.isForceInclusion) pwr1.resolve();
        else if (event.name === "add") pwr2.resolve();
      }
    });
    yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

    yield* Effect.forkChild(runtime.program);

    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );
    yield* Effect.promise(() => setupIncluded.promise);

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
        abi: FFCA_ABI,
        functionName: "enqueue",
        args: [
          COUNTER_MUTATIONS.add.tag,
          mutationData,
          encodeSignatureCalldata(
            COUNTER_SIGNATURE_PARAMS,
            forceIncludedSignature,
          ),
        ],
      }),
    );

    yield* Effect.promise(() => Promise.all([pwr1.promise, pwr2.promise]));
  });

  await Effect.runPromise(program);

  expect(
    await readContractStorage(COUNTER_STORAGE_LAYOUT, address, "total"),
  ).toBe(acceptedAmount + forceIncludedAmount);
});

test("runtime handles failing mutation", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
      Effect.provide(scopedServices),
      Effect.provideService(Scope.Scope, scope),
    );

    yield* Effect.forkChild(runtime.program);
    yield* runtime.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
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
  });

  const exit = await Effect.runPromise(program);

  expect(Exit.isFailure(exit)).toBe(true);
  expect(
    await readContractStorage(COUNTER_STORAGE_LAYOUT, address, "total"),
  ).toBe(0n);
});

test("runtime program handles interrupt", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);

  const config: FFCAConfig = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo" },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    mutations: COUNTER_MUTATIONS,
  };

  const schema = createMutationSchema(config);
  const services = layerRuntimeServices(address);

  const program = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const scopedServices = yield* Layer.buildWithScope(services, scope);

    yield* migrate(schema, config.chainId, config.address).pipe(
      Effect.provide(scopedServices),
    );

    const runtime = yield* createRuntimeFIFOEffect(config, schema).pipe(
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
