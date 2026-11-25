import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  type Scope,
} from "effect";
import { Hex, Secp256k1 } from "ox";
import { createStorageView } from "storage-layout";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import { startDevChain } from "./anvil";
import { createAccountMutation, createSigner, KeyType } from "./client";
import {
  createTypewriterApp,
  type DeployedTypewriterApp,
  deployedApp,
  type TypewriterApp,
} from "./config";
import { layerDatabase, makeDb } from "./db";
import { dropSchema } from "./db-migrate";
import {
  encodeSecp256k1PublicKey,
  secp256k1SchedulerCredential,
} from "./encoding";
import { layerRpc } from "./rpc";
import { makeHttpTransport } from "./rpc-transport";
import {
  findSchedulerCredential,
  readSchedulerCredentials,
  type StoredSchedulerCredential,
  schedulerOf,
  seedScheduler,
} from "./scheduler";
import { loadSolidityApp } from "./sol-build";
import { createTypewriterEffect } from "./typewriter";
import { SchedulerRole, TYPEWRITER_ABI } from "./typewriter-constants";
import type { BlockEvent, SchedulerCredential } from "./typewriter-types";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
const HAS_ANVIL = Bun.which("anvil") !== null;

const SCHEDULER = privateKeyToAccount(`0x${"51".repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${"07".repeat(32)}`);
/** Anvil's second default account, which has ether to send with. */
const FUNDED = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const credential = (
  address: Hex.Hex,
  role: SchedulerRole,
  expiration = 0,
): StoredSchedulerCredential => ({
  expiration,
  keyType: KeyType.Secp256k1,
  role,
  publicKey: encodeSecp256k1PublicKey(address),
});

const REMOVED: StoredSchedulerCredential = {
  expiration: 0,
  keyType: 0,
  role: 0,
  publicKey: "0x",
};

test("findSchedulerCredential finds the newest live credential of the scheduler, of any role", () => {
  const credentials = [
    credential(SCHEDULER.address, SchedulerRole.Root),
    credential(OTHER.address, SchedulerRole.Executor),
    credential(SCHEDULER.address, SchedulerRole.Issuer, 100),
    REMOVED,
  ];

  expect(findSchedulerCredential(credentials, SCHEDULER.address, 100n)).toEqual(
    {
      id: 2n,
      expiration: 100,
    },
  );
  // Expired after its expiration, as `execute` checks it.
  expect(findSchedulerCredential(credentials, SCHEDULER.address, 101n)).toEqual(
    {
      id: 0n,
      expiration: 0,
    },
  );
  expect(findSchedulerCredential(credentials, OTHER.address, 0n)).toEqual({
    id: 1n,
    expiration: 0,
  });
});

test("findSchedulerCredential finds nothing without a live credential of the scheduler", () => {
  const scheduler = SCHEDULER.address;
  expect(findSchedulerCredential([], scheduler, 0n)).toBeUndefined();
  expect(findSchedulerCredential([REMOVED], scheduler, 0n)).toBeUndefined();
  expect(
    findSchedulerCredential(
      [credential(scheduler, SchedulerRole.Executor, 10)],
      scheduler,
      11n,
    ),
  ).toBeUndefined();
  // A P-256 credential, even with the same bytes, is another key.
  expect(
    findSchedulerCredential(
      [{ ...credential(scheduler, SchedulerRole.Root), keyType: KeyType.P256 }],
      scheduler,
      0n,
    ),
  ).toBeUndefined();
});

let schemas = 0;

/**
 * Starts Anvil and runs `body` with it and an app of the assessment contract
 * for it: a dev app unless `config` is set, else one with Anvil's first
 * account as the root and the relayer, `config`, and a schema that is
 * dropped when the scope closes.
 */
const withChain = <a, e>(
  body: (
    app: (config?: {
      scheduler: LocalAccount;
    }) => Effect.Effect<TypewriterApp, never, Scope.Scope>,
  ) => Effect.Effect<a, e, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const solidityApp = yield* Effect.promise(() =>
      loadSolidityApp(ASSESSMENT_ENTRYPOINT),
    );
    const devChain = yield* startDevChain();
    return yield* body((config) =>
      Effect.gen(function* () {
        if (config === undefined) {
          return createTypewriterApp({
            ...solidityApp,
            config: {
              dev: true,
              database: { url: DATABASE_URL ?? "", maxConnections: 4 },
            },
            devChain,
          });
        }
        const schema = `typewriter_test_scheduler_${process.pid}_${schemas++}`;
        yield* Effect.addFinalizer(() =>
          Effect.scoped(
            Effect.flatMap(makeDb({ url: DATABASE_URL ?? "" }), (db) =>
              dropSchema(db, schema),
            ),
          ).pipe(Effect.orDie),
        );
        return createTypewriterApp({
          ...solidityApp,
          config: {
            root: devChain.account.address,
            relayer: devChain.account,
            chainId: devChain.chainId,
            hardfork: devChain.hardfork,
            rpcUrl: devChain.rpcUrl,
            deployment: schema,
            database: { url: DATABASE_URL ?? "", maxConnections: 4 },
            ...config,
          },
        });
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.provide(Logger.layer([])),
    Effect.runPromise,
  );

/**
 * The runtime of `app`, its services, and the app at its deployment, built in
 * the scope as `createTypewriter` builds them. It deploys the contract on an
 * empty schema.
 */
const createRuntime = (app: TypewriterApp) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(
        layerRpc([makeHttpTransport(app.rpcUrls[0])]),
        layerDatabase(app.database),
      ),
    );
    const typewriter = yield* createTypewriterEffect(app).pipe(
      Effect.provide(services),
    );
    return {
      typewriter,
      services,
      app: deployedApp(app, typewriter.address),
    };
  });

type Runtime = Effect.Success<ReturnType<typeof createRuntime>>;

const clients = (app: DeployedTypewriterApp) => ({
  public: createPublicClient({ transport: http(app.rpcUrls[0]) }),
  wallet: (account: LocalAccount) =>
    createWalletClient({ account, transport: http(app.rpcUrls[0]) }),
});

/** Sends `data` to the app from `account`, and waits for it to succeed. */
const send = (
  app: DeployedTypewriterApp,
  account: LocalAccount,
  data: Hex.Hex,
) =>
  Effect.promise(async () => {
    const { public: publicClient, wallet } = clients(app);
    const hash = await wallet(account).sendTransaction({
      to: app.address,
      data,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  });

/** Adds `credential` from the address of scheduler credential `credentialID`. */
const schedulerAddCredential = (
  app: DeployedTypewriterApp,
  sender: LocalAccount,
  credentialID: bigint,
  nonce: bigint,
  added: SchedulerCredential,
) =>
  send(
    app,
    sender,
    encodeFunctionData({
      abi: TYPEWRITER_ABI,
      functionName: "schedulerAddCredential",
      args: [added, nonce, 0, { credentialID, signature: "0x" }],
    }),
  );

/**
 * Runs `runtime`, executes one new account's `CreateAccount`, and returns the
 * `execute` arguments of the settlement that included it.
 */
const settleOne = ({ typewriter, services, app }: Runtime) =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(typewriter.program.pipe(Effect.provide(services)));

    const privateKey = Secp256k1.randomPrivateKey();
    const signer = createSigner(app.manifest, {
      keyType: KeyType.Secp256k1,
      address: privateKeyToAccount(privateKey).address,
      sign: async (payload) => Secp256k1.sign({ payload, privateKey }),
    });
    const signed = yield* Effect.promise(() =>
      signer.signMutation(createAccountMutation(signer)),
    );

    const included = yield* Deferred.make<BlockEvent<"fifo" | "batch">>();
    yield* typewriter.on("block", (event) => {
      if (event.status === "included") {
        Deferred.doneUnsafe(included, Effect.succeed(event));
      }
    });
    yield* typewriter.execute({
      mutation: signed.mutation,
      signature: signed.signature,
    } as never);
    const block = yield* Deferred.await(included).pipe(
      Effect.timeout("20 seconds"),
    );
    expect(
      typewriter.accounts[signed.mutation.accountID]?.credentials.length,
    ).toBe(1);

    const { transactions } = yield* Effect.promise(() =>
      clients(app).public.getBlock({
        blockNumber: block.number,
        includeTransactions: true,
      }),
    );
    const settlement = transactions.find(
      (transaction) =>
        transaction.to?.toLowerCase() === app.address.toLowerCase(),
    )!;
    expect(settlement.from.toLowerCase()).toBe(
      app.relayer.address.toLowerCase(),
    );
    const { args } = decodeFunctionData({
      abi: TYPEWRITER_ABI,
      data: settlement.input,
    });
    return args as readonly [
      unknown,
      unknown,
      unknown,
      unknown,
      { credentialID: bigint; signature: Hex.Hex },
    ];
  });

test.skipIf(!HAS_ANVIL || DATABASE_URL === undefined)(
  "seedScheduler reads the scheduler the constructor wrote",
  () =>
    withChain((makeApp) =>
      Effect.gen(function* () {
        const { app } = yield* createRuntime(yield* makeApp());
        const transport = makeHttpTransport(app.rpcUrls[0]);
        const storage = {};
        yield* seedScheduler(app.storageLayout, storage, new Set(), (slots) =>
          Effect.forEach(slots, (slot) =>
            transport.request({
              method: "eth_getStorageAt",
              params: [app.address, slot, "latest"],
            }),
          ),
        ).pipe(Effect.orDie);

        const scheduler = schedulerOf(
          createStorageView(
            app.storageLayout,
            (slots) =>
              slots.map(
                (slot) =>
                  (storage as Record<string, Hex.Hex>)[slot] ??
                  Hex.fromNumber(0, { size: 32 }),
              ),
            new Set(),
          ),
        );
        expect(readSchedulerCredentials(scheduler)).toEqual([
          {
            expiration: 0,
            keyType: KeyType.Secp256k1,
            role: SchedulerRole.Root,
            publicKey: encodeSecp256k1PublicKey(app.scheduler.address),
          },
        ]);
        expect(scheduler.rootCredentials).toBe(1n);
        expect(scheduler.nonce).toBe(0n);
      }),
    ),
);

test.skipIf(!HAS_ANVIL || DATABASE_URL === undefined)(
  "the runtime fails to start without a scheduler credential for its scheduler",
  () =>
    withChain((makeApp) =>
      Effect.gen(function* () {
        // The deployment's credentials are Anvil's account, a root, and
        // SCHEDULER, an executor. A restart on its schema with another
        // scheduler resumes it.
        const app = yield* makeApp({ scheduler: SCHEDULER });
        const { address } = yield* Effect.scoped(
          Effect.map(createRuntime(app), ({ app }) => app),
        );
        const error = yield* createRuntime({ ...app, scheduler: OTHER }).pipe(
          Effect.flip,
        );

        expect(error._tag).toBe("SchedulerCredentialNotFoundError");
        expect(error.message).toContain(OTHER.address);
        expect(error.message).toContain(address);
      }),
    ),
);

test.skipIf(!HAS_ANVIL || DATABASE_URL === undefined)(
  "the runtime's settlements land unsigned when its scheduler relays",
  () =>
    withChain((makeApp) =>
      Effect.gen(function* () {
        const [, , , , { credentialID, signature }] = yield* settleOne(
          yield* createRuntime(yield* makeApp()),
        );

        expect(credentialID).toBe(0n);
        expect(signature).toBe("0x");
      }),
    ),
);

test.skipIf(!HAS_ANVIL || DATABASE_URL === undefined)(
  "the runtime's settlements land signed by a scheduler other than its relayer",
  () =>
    withChain((makeApp) =>
      Effect.gen(function* () {
        // The deployment makes the scheduler an executor, credential 1,
        // under Anvil's account as the root.
        const [, , , , { credentialID, signature }] = yield* settleOne(
          yield* createRuntime(yield* makeApp({ scheduler: SCHEDULER })),
        );

        expect(credentialID).toBe(1n);
        expect(Hex.size(signature as Hex.Hex)).toBe(65);
      }),
    ),
);

test.skipIf(!HAS_ANVIL || DATABASE_URL === undefined)(
  "the runtime stops once its scheduler credential is removed",
  () =>
    withChain((makeApp) =>
      Effect.gen(function* () {
        const { typewriter, services, app } = yield* createRuntime(
          yield* makeApp(),
        );
        const program = yield* Effect.forkScoped(
          typewriter.program.pipe(Effect.provide(services)),
        );

        // The dev credential adds another root, so it isn't the last.
        yield* schedulerAddCredential(
          app,
          app.scheduler,
          0n,
          0n,
          secp256k1SchedulerCredential(FUNDED.address, SchedulerRole.Root),
        );
        // The new root removes the dev credential, which the runtime uses.
        yield* send(
          app,
          FUNDED,
          encodeFunctionData({
            abi: TYPEWRITER_ABI,
            functionName: "schedulerRemoveCredential",
            args: [0n, 1n, 0, { credentialID: 1n, signature: "0x" }],
          }),
        );

        const exit = yield* Fiber.await(program).pipe(
          Effect.timeout("20 seconds"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const pretty = Cause.pretty(exit.cause);
          expect(pretty).toContain("SchedulerCredentialRemovedError");
          expect(pretty).toContain("Scheduler credential 0");
        }
      }),
    ),
);
