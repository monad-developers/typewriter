import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect";
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
  deployCounter,
  deployHarness,
  nativeAccountID,
  p256PublicKey,
  prepareCounterAdd,
  prepareCounterCreateAccount,
  prepareHarnessAddCredential,
  prepareHarnessCreateAccount,
  prepareHarnessMutation,
  readContractStorage,
  secp256k1PublicKey,
} from "../test/utils";
import { layerDatabaseLive } from "./db";
import {
  encodeAuthorizationCalldata,
  encodeMutationCalldata,
  TYPEWRITER_ABI,
} from "./encoding";
import type { InternalApp } from "./internal";
import { deploymentSchemaName, migrate } from "./migrate";
import { layerRpcLive } from "./rpc";
import { createRuntimeEffect } from "./runtime";
import { loadSolidityTypewriterApp } from "./sol-parse";
import type { InternalRuntimeTypewriter } from "./typewriter";
import { layerWatchLive } from "./watch";

function layerRuntimeServices(address: Address) {
  const rpcLayer = layerRpcLive({ rpcUrls: [TEST_RPC_URL] });
  const dbLayer = layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 });
  const forceInclusionEvent = getAbiItem({
    abi: TYPEWRITER_ABI,
    name: "ForceInclusionQueued",
  });
  const watchLayer = layerWatchLive({
    pollIntervalMs: 50,
    maxChainDepth: 5,
    logFilter: {
      address,
      selector: toEventSelector(forceInclusionEvent),
    },
  }).pipe(Layer.provide(rpcLayer));

  return rpcLayer.pipe(Layer.merge(dbLayer), Layer.merge(watchLayer));
}

function runWithRuntime<R>(
  app: InternalApp,
  run: (
    runtime: InternalRuntimeTypewriter,
  ) => Effect.Effect<R, unknown, Scope.Scope>,
): Promise<R> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate(app.schema, app.chainId, app.address, 0n);
        const runtime = yield* createRuntimeEffect(app);
        yield* Effect.forkScoped(runtime.program);
        return yield* run(runtime);
      }).pipe(Effect.provide(layerRuntimeServices(app.address))),
    ),
  );
}

function counterApp(address: Address) {
  return loadSolidityTypewriterApp(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder: ["CreateAccount", "Add"],
      batchIntervalMs: 20,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    blockPollingIntervalMs: 50,
  });
}

function harnessApp(address: Address, batchOrder: readonly string[]) {
  return loadSolidityTypewriterApp(Harness, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder,
      batchIntervalMs: 20,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 1 },
    blockPollingIntervalMs: 50,
  });
}

test("runtime loads persisted root state before returning", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const schemaName = deploymentSchemaName(anvil.id, address);

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate(app.schema, app.chainId, app.address, 0n);
        yield* Effect.promise(
          () => TEST_DB_CONNECTION`
            INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.add_mutations
              (id, status, amount, authorization_account_id, authorization_credential_id, authorization_nonce, authorization_expiration, authorization_signature)
            VALUES
              (0, 'included', 7, '0x0000000000000000000000000000000000000000000000000000000000000000', 0, 0, 0, '0x')
          `,
        );
        yield* Effect.promise(
          () => TEST_DB_CONNECTION`
            INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.slot_writes
              (${TEST_DB_CONNECTION("mutationId")}, slot, value)
            VALUES
              (0, ${"0x0000000000000000000000000000000000000000000000000000000000000003"}, ${"0x0000000000000000000000000000000000000000000000000000000000000007"})
          `,
        );

        const runtime = yield* createRuntimeEffect(app);
        const state = runtime.state as { total: Promise<bigint> };
        return yield* Effect.promise(() => state.total);
      }).pipe(Effect.provide(layerRuntimeServices(address))),
    ),
  );

  expect(result).toBe(7n);
});

test("runtime enumerates mapping keys from persisted preimages", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const schemaName = deploymentSchemaName(anvil.id, address);
  const accountId = `0x${"ab".repeat(32)}`;
  const accountsSlot = app.storageLayout.storage.find(
    (item) => item.label === "accounts",
  )!.slot;
  const preimage = `${accountId}${BigInt(accountsSlot).toString(16).padStart(64, "0")}`;

  const keys = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate(app.schema, app.chainId, app.address, 0n);
        yield* Effect.promise(
          () => TEST_DB_CONNECTION`
            INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.keccak_preimages (preimage)
            VALUES (${preimage})
          `,
        );

        const runtime = yield* createRuntimeEffect(app);
        return Object.keys(runtime.accounts);
      }).pipe(Effect.provide(layerRuntimeServices(address))),
    ),
  );

  expect(keys).toEqual([accountId]);
});

test("runtime enumerates mapping keys registered by accepted mutations", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });

  const keys = await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      const before = Object.keys(runtime.accounts);
      yield* runtime.execute(createAccount);
      return { before, after: Object.keys(runtime.accounts) };
    }),
  );

  expect(keys.before).toEqual([]);
  expect(keys.after).toHaveLength(1);

  // The preimages were persisted, so a restarted runtime lists the same keys.
  const restarted = await runWithRuntime(app, (runtime) =>
    Effect.sync(() => Object.keys(runtime.accounts)),
  );
  expect(restarted).toEqual(keys.after);
});

test("runtime accepts native account and app mutations", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const add = await prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
    amount: 7n,
    sequence: 0n,
  });

  const results = await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      const accountResult = yield* runtime.execute(createAccount);
      const addResult = yield* runtime.execute(add);
      return [accountResult, addResult];
    }),
  );

  expect(results).toEqual([{ id: 0 }, { id: 1 }]);
});

test("runtime emits the accepted through finalized mutation lifecycle", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const add = await prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
    amount: 7n,
    sequence: 0n,
  });
  const statuses: string[] = [];

  await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const finalized = Promise.withResolvers<void>();
      const unsubscribe = yield* runtime.on("mutation", (event) => {
        if (event.name !== "Add") return;
        statuses.push(event.status);
        if (event.status === "finalized") finalized.resolve();
      });
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      yield* runtime.execute(createAccount);
      yield* runtime.execute(add);
      yield* Effect.promise(() => finalized.promise);
    }),
  );

  expect(statuses).toEqual([
    "received",
    "accepted",
    "included",
    "safe",
    "finalized",
  ]);
});

test("runtime persists fixed authorization fields and app params", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const add = await prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
    amount: 9n,
    sequence: 0n,
  });

  await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.execute(createAccount);
      yield* runtime.execute(add);
    }),
  );

  const db = drizzle({ client: TEST_DB_CONNECTION });
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket access.
  const rows = await db.select().from(app.schema["add_mutations"]!);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: 1,
    amount: 9n,
    authorization_account_id: add.authorization.accountID,
    authorization_credential_id: 0n,
    authorization_nonce: 0n,
    authorization_expiration: 0n,
    authorization_signature: add.authorization.signature,
  });
});

test("runtime submits authenticated state transitions onchain", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const add = await prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
    amount: 7n,
    sequence: 0n,
  });

  await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const included = Promise.withResolvers<void>();
      const unsubscribe = yield* runtime.on("mutation", (event) => {
        if (event.name === "Add" && event.status === "included") {
          included.resolve();
        }
      });
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));
      yield* runtime.execute(createAccount);
      yield* runtime.execute(add);
      yield* Effect.promise(() => included.promise);
    }),
  );

  expect(
    await readContractStorage(app.storageLayout, address, "state.total"),
  ).toBe(7n);
});

test("batch ordering executes credit before a submitted debit", async () => {
  const address = await deployHarness();
  const app = await harnessApp(address, ["CreateAccount", "Credit", "Debit"]);
  const publicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const accountID = nativeAccountID(2, publicKey);
  const createAccount = await prepareHarnessCreateAccount({
    keyType: 2,
    publicKey,
    privateKey: ALICE_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const debit = await prepareHarnessMutation({
    mutation: "Debit",
    params: { amount: 30n },
    accountID,
    sequence: 1n,
    keyType: 2,
    privateKey: ALICE_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const credit = await prepareHarnessMutation({
    mutation: "Credit",
    params: { amount: 100n },
    accountID,
    sequence: 0n,
    keyType: 2,
    privateKey: ALICE_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });

  const balance = await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.execute(createAccount);
      yield* Effect.all([runtime.execute(debit), runtime.execute(credit)], {
        concurrency: "unbounded",
      });
      const state = runtime.state as {
        balances: Record<string, Promise<bigint> | undefined>;
      };
      return yield* Effect.promise(() => state.balances[accountID]!);
    }),
  );

  expect(balance).toBe(70n);
});

test("runtime uses native credentials for P256 and WebAuthn mutations", async () => {
  const address = await deployHarness();
  const app = await harnessApp(address, [
    "CreateAccount",
    "AddCredential",
    "Credit",
  ]);
  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const accountID = nativeAccountID(2, rootPublicKey);
  const p256Key = p256PublicKey(P256_PRIVATE_KEY);
  const createAccount = await prepareHarnessCreateAccount({
    keyType: 2,
    publicKey: rootPublicKey,
    privateKey: ALICE_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const addP256 = await prepareHarnessAddCredential({
    accountID,
    expiration: 0n,
    credentialKeyType: 0,
    signerKeyType: 2,
    permissions: (1n << 0n) | (1n << 254n),
    publicKey: p256Key,
    privateKey: ALICE_PRIVATE_KEY,
    sequence: 0n,
    address,
    chainId: anvil.id,
  });
  const p256Credit = await prepareHarnessMutation({
    mutation: "Credit",
    params: { amount: 100n },
    accountID,
    credentialID: 1n,
    sequence: 1n,
    keyType: 0,
    privateKey: P256_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const addWebAuthn = await prepareHarnessAddCredential({
    accountID,
    credentialID: 1n,
    expiration: 0n,
    credentialKeyType: 1,
    signerKeyType: 0,
    permissions: 1n << 0n,
    publicKey: p256Key,
    privateKey: P256_PRIVATE_KEY,
    sequence: 2n,
    address,
    chainId: anvil.id,
  });
  const webAuthnCredit = await prepareHarnessMutation({
    mutation: "Credit",
    params: { amount: 50n },
    accountID,
    credentialID: 2n,
    sequence: 3n,
    keyType: 1,
    privateKey: P256_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });

  const balance = await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.execute(createAccount);
      yield* runtime.execute(addP256);
      yield* runtime.execute(p256Credit);
      yield* runtime.execute(addWebAuthn);
      yield* runtime.execute(webAuthnCredit);
      const state = runtime.state as {
        balances: Record<string, Promise<bigint> | undefined>;
      };
      return yield* Effect.promise(() => state.balances[accountID]!);
    }),
  );

  expect(balance).toBe(150n);
});

test("runtime rejects an invalid native nonce without changing app state", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const invalidAdd = await prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
    amount: 7n,
    sequence: 1n,
  });

  const exit = await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.execute(createAccount);
      return yield* Effect.exit(runtime.execute(invalidAdd));
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(
    await readContractStorage(app.storageLayout, address, "state.total"),
  ).toBe(0n);
});

test("runtime includes an onchain force-inclusion enqueue", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const createAccount = await prepareCounterCreateAccount({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const add = await prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
    amount: 5n,
    sequence: 0n,
  });
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket access.
  const addConfig = app.mutations["Add"]!;
  const mutationData = encodeMutationCalldata({
    id: 1,
    status: "accepted",
    name: "Add",
    params: add.params,
    authorization: add.authorization,
    journalId: 1,
    isForceInclusion: false,
    config: addConfig,
  });
  const authorizationData = encodeAuthorizationCalldata(add.authorization);
  const userWalletClient = createWalletClient({
    account: USER_ACCOUNT,
    chain: anvil,
    transport: http(TEST_RPC_URL),
  });

  await runWithRuntime(app, (runtime) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const setupIncluded = Promise.withResolvers<void>();
      const forceIncluded = Promise.withResolvers<void>();
      const unsubscribe = yield* runtime.on("mutation", (event) => {
        if (event.name === "CreateAccount" && event.status === "included") {
          setupIncluded.resolve();
        }
        if (event.status === "included" && event.isForceInclusion) {
          forceIncluded.resolve();
        }
      });
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      yield* runtime.execute(createAccount);
      yield* Effect.promise(() => setupIncluded.promise);
      yield* Effect.promise(() =>
        userWalletClient.writeContract({
          account: USER_ACCOUNT,
          chain: anvil,
          address,
          abi: TYPEWRITER_ABI,
          functionName: "enqueue",
          args: [addConfig.id, mutationData, authorizationData],
        }),
      );
      yield* Effect.promise(() => forceIncluded.promise);
    }),
  );

  expect(
    await readContractStorage(app.storageLayout, address, "state.total"),
  ).toBe(5n);
});

test("runtime program handles interrupt", async () => {
  const address = await deployCounter();
  const app = await counterApp(address);
  const services = layerRuntimeServices(address);
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate(app.schema, app.chainId, app.address, 0n);
        const runtime = yield* createRuntimeEffect(app);
        const fiber = yield* Effect.forkChild(runtime.program);
        yield* Effect.sleep("25 millis");
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(services)),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }
});
