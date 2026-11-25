import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { sql } from "drizzle-orm";
import { Effect, Layer, Logger, type Scope } from "effect";
import { Hex } from "ox";
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  type LocalAccount,
  parseEventLogs,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import { startDevChain } from "./anvil";
import {
  createTypewriterApp,
  type DevChain,
  type TypewriterApp,
  type TypewriterConfig,
} from "./config";
import { layerDatabase, makeDb } from "./db";
import { dropSchema } from "./db-migrate";
import { builder } from "./db-transport";
import {
  CREATE2_DEPLOYER,
  CREATE2_DEPLOYER_SENDER,
  creationCodeHash,
} from "./deploy";
import { layerRpc } from "./rpc";
import { makeHttpTransport } from "./rpc-transport";
import { loadSolidityApp } from "./sol-build";
import { createTypewriterEffect } from "./typewriter";
import { TYPEWRITER_ABI } from "./typewriter-constants";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
const HAS_ANVIL = Bun.which("anvil") !== null;
const INTEGRATION = HAS_ANVIL && DATABASE_URL !== undefined;

/** Anvil's second default account, which has ether to pay with. */
const FUNDED = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ROOT = privateKeyToAccount(`0x${"61".repeat(32)}`);
const SCHEDULER = privateKeyToAccount(`0x${"62".repeat(32)}`);

const solidityApp = INTEGRATION
  ? await loadSolidityApp(ASSESSMENT_ENTRYPOINT)
  : undefined;

let schemas = 0;
const newSchema = () =>
  `typewriter_test_deploy_${process.pid}_${Date.now() % 1_000_000}_${schemas++}`;

const run = <a, e>(
  body: Effect.Effect<a, e, Scope.Scope | BunServices.BunServices>,
) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.provide(Logger.layer([])),
    Effect.runPromise,
  );

/**
 * An app of the assessment contract on `chain`, whose schema is dropped when
 * the scope closes. Anvil's first account is the root, scheduler, and relayer
 * unless `config` says otherwise.
 */
const makeApp = (
  chain: DevChain,
  config: Partial<Pick<TypewriterConfig<"fifo", false>, "root" | "relayer">> & {
    scheduler?: LocalAccount;
    schema?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const { schema = newSchema(), ...rest } = config;
    yield* Effect.addFinalizer(() =>
      Effect.scoped(
        Effect.flatMap(makeDb({ url: DATABASE_URL! }), (db) =>
          dropSchema(db, schema),
        ),
      ).pipe(Effect.orDie),
    );
    return createTypewriterApp({
      ...solidityApp!,
      config: {
        root: chain.account.address,
        scheduler: chain.account,
        chainId: chain.chainId,
        hardfork: chain.hardfork,
        rpcUrl: chain.rpcUrl,
        deployment: schema,
        database: { url: DATABASE_URL!, maxConnections: 4 },
        ...rest,
      },
    });
  });

/** Starts the runtime of `app` in the scope, as `createTypewriter` does. */
const start = (app: TypewriterApp) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(
        layerRpc([makeHttpTransport(app.rpcUrls[0])]),
        layerDatabase(app.database),
      ),
    );
    return yield* createTypewriterEffect(app).pipe(Effect.provide(services));
  });

/** Starts the runtime of `app` and stops it again. */
const startAndStop = (app: TypewriterApp) =>
  Effect.scoped(
    Effect.map(start(app), ({ address, migration, manifest }) => ({
      address,
      migration,
      manifest,
    })),
  );

const publicClient = (chain: DevChain) =>
  createPublicClient({ transport: http(chain.rpcUrl) });

const nonceOf = (chain: DevChain, address: Address) =>
  Effect.promise(() =>
    publicClient(chain).getTransactionCount({ address, blockTag: "latest" }),
  );

/** The CREATE2 address of the app for `deployment`, computed with viem. */
const expectedAddress = (
  deployment: string,
  credentials: readonly { address: Address; role: number }[],
) =>
  getContractAddress({
    opcode: "CREATE2",
    from: CREATE2_DEPLOYER,
    salt: keccak256(toHex(deployment)),
    bytecode: concat([
      solidityApp!.bytecode,
      encodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [
              { type: "uint40" },
              { type: "uint8" },
              { type: "uint8" },
              { type: "bytes" },
            ],
          },
        ],
        [
          credentials.map(
            ({ address, role }) =>
              [
                0,
                2, // KeyType.Secp256k1
                role,
                encodeAbiParameters([{ type: "address" }], [address]),
              ] as const,
          ),
        ],
      ),
    ]),
  });

/** The scheduler credentials that the contract at `address` was created with. */
const genesisLogs = (chain: DevChain, address: Address) =>
  Effect.promise(async () => {
    const logs = await publicClient(chain).getLogs({
      address,
      fromBlock: 0n,
      toBlock: "latest",
    });
    return parseEventLogs({
      abi: TYPEWRITER_ABI,
      eventName: "SchedulerCredentialAdded",
      logs,
    }).map(({ args }) => ({
      id: args.credentialID,
      role: args.credential.role,
      publicKey: args.credential.publicKey,
    }));
  });

test("creationCodeHash ignores the trailing solc metadata, and nothing else", () => {
  const code = "0x6080604052";
  const metadata = (hash: string) =>
    `a2646970667358221220${hash.repeat(32)}64736f6c63430008250033`;
  const withMetadata = (hash: string) => `${code}${metadata(hash)}` as Hex.Hex;

  expect(creationCodeHash(withMetadata("11"))).toBe(
    creationCodeHash(withMetadata("22")),
  );
  expect(creationCodeHash(withMetadata("11"))).not.toBe(
    creationCodeHash(`0x6080604053${metadata("11")}`),
  );
  // Code without metadata hashes whole.
  expect(creationCodeHash(code)).toBe(keccak256(code));
  expect(creationCodeHash("0x")).toBe(keccak256("0x"));
});

test.skipIf(!INTEGRATION)(
  "the first start on an empty schema deploys at the schema's CREATE2 address, and later starts resume it",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain();
        const app = yield* makeApp(chain);
        const expected = expectedAddress(app.deployment, [
          { address: chain.account.address, role: 2 },
        ]);

        const first = yield* startAndStop(app);
        expect(first.migration).toBe("created");
        expect(first.address.toLowerCase()).toBe(expected.toLowerCase());
        expect(first.manifest.address).toBe(first.address);
        const code = yield* Effect.promise(() =>
          publicClient(chain).getCode({ address: expected }),
        );
        expect(code?.length).toBeGreaterThan(2);
        // The root is the scheduler, so it is the one credential.
        expect(yield* genesisLogs(chain, expected)).toEqual([
          {
            id: 0n,
            role: 2,
            publicKey: encodeAbiParameters(
              [{ type: "address" }],
              [chain.account.address],
            ),
          },
        ]);

        const metadata = yield* Effect.scoped(
          Effect.flatMap(makeDb({ url: DATABASE_URL! }), (db) =>
            db.run(
              builder.select().from(app.typewriterSchema.typewriterMetadata),
            ),
          ),
        );
        expect(metadata).toEqual([
          {
            schema_version: 2,
            address: expected.toLowerCase() as Hex.Hex,
            chain_id: chain.chainId,
            code_hash: keccak256(code!),
            creation_code_hash: creationCodeHash(solidityApp!.bytecode),
          },
        ]);

        const nonce = yield* nonceOf(chain, chain.account.address);
        const second = yield* startAndStop(app);
        expect(second.migration).toBe("resumed");
        expect(second.address).toBe(first.address);
        expect(yield* nonceOf(chain, chain.account.address)).toBe(nonce);
      }),
    ),
);

test.skipIf(!INTEGRATION)(
  "a start fails when the contract changed since the schema's deployment",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain();
        const app = yield* makeApp(chain);
        const { address } = yield* startAndStop(app);

        // Only the solc metadata changed, as for a comment: it resumes.
        const size = Hex.size(app.bytecode);
        const metadataLength = Hex.toNumber(Hex.slice(app.bytecode, size - 2));
        const trailerStart = size - 2 - metadataLength;
        const commentOnly = Hex.concat(
          Hex.slice(app.bytecode, 0, trailerStart + 10),
          Hex.fromNumber(0xee, { size: 1 }),
          Hex.slice(app.bytecode, trailerStart + 11),
        );
        expect(commentOnly).not.toBe(app.bytecode);
        expect(
          (yield* startAndStop({ ...app, bytecode: commentOnly })).migration,
        ).toBe("resumed");

        const changed = Hex.concat("0x00", app.bytecode);
        const error = yield* startAndStop({ ...app, bytecode: changed }).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("DeploymentError");
        expect(error.message).toBe(
          `${app.contractName} changed since deployment ${app.deployment} was deployed at ${address.toLowerCase()}; to deploy the new code, use a new config.deployment`,
        );
      }),
    ),
);

test.skipIf(!INTEGRATION)(
  "a start fails when the schema's deployment is on another chain",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain();
        const app = yield* makeApp(chain);
        const { address } = yield* startAndStop(app);

        yield* Effect.scoped(
          Effect.flatMap(makeDb({ url: DATABASE_URL! }), (db) =>
            db.run(
              builder.execute(
                sql`UPDATE ${sql.identifier(app.schemaName)}.typewriter_metadata SET chain_id = 1`,
              ),
            ),
          ),
        );
        const wrongChain = yield* startAndStop(app).pipe(Effect.flip);
        expect(wrongChain._tag).toBe("DeploymentError");
        expect(wrongChain.message).toBe(
          `Deployment ${app.deployment} is at ${address.toLowerCase()} on chain 1, but config.chainId is ${chain.chainId}; use another config.deployment for another chain`,
        );
      }),
    ),
);

test.skipIf(!INTEGRATION)(
  "a start adopts the contract already at the schema's address",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain();
        const app = yield* makeApp(chain);
        const expected = expectedAddress(app.deployment, [
          { address: chain.account.address, role: 2 },
        ]);

        // Another account sends the same deployment first, as an earlier
        // start does before it crashes.
        yield* Effect.promise(async () => {
          const hash = await createWalletClient({
            account: FUNDED,
            transport: http(chain.rpcUrl),
          }).sendTransaction({
            to: CREATE2_DEPLOYER,
            data: concat([
              keccak256(toHex(app.deployment)),
              expectedInitcode(chain.account.address),
            ]),
            chain: null,
          });
          await publicClient(chain).waitForTransactionReceipt({ hash });
        });
        expect(
          yield* Effect.promise(() =>
            publicClient(chain).getCode({ address: expected }),
          ),
        ).toBeDefined();

        const nonce = yield* nonceOf(chain, chain.account.address);
        const adopted = yield* startAndStop(app);
        expect(adopted.migration).toBe("created");
        expect(adopted.address.toLowerCase()).toBe(expected.toLowerCase());
        expect(yield* nonceOf(chain, chain.account.address)).toBe(nonce);
      }),
    ),
);

/** The initcode of the app with `root` as its one credential. */
const expectedInitcode = (root: Address) =>
  concat([
    solidityApp!.bytecode,
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { type: "uint40" },
            { type: "uint8" },
            { type: "uint8" },
            { type: "bytes" },
          ],
        },
      ],
      [[[0, 2, 2, encodeAbiParameters([{ type: "address" }], [root])]]],
    ),
  ]);

test.skipIf(!INTEGRATION)(
  "the relayer pays the deployment, which makes the scheduler an executor under the root",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain();
        const app = yield* makeApp(chain, {
          root: ROOT.address,
          scheduler: SCHEDULER,
          relayer: FUNDED,
        });
        const expected = expectedAddress(app.deployment, [
          { address: ROOT.address, role: 2 },
          { address: SCHEDULER.address, role: 0 },
        ]);

        const relayerNonce = yield* nonceOf(chain, FUNDED.address);
        const { address, migration } = yield* startAndStop(app);
        expect(migration).toBe("created");
        expect(address.toLowerCase()).toBe(expected.toLowerCase());
        expect(yield* nonceOf(chain, FUNDED.address)).toBe(relayerNonce + 1);
        expect(yield* nonceOf(chain, SCHEDULER.address)).toBe(0);
        expect(
          (yield* genesisLogs(chain, expected)).map(({ id, role }) => ({
            id,
            role,
          })),
        ).toEqual([
          { id: 0n, role: 2 },
          { id: 1n, role: 0 },
        ]);
      }),
    ),
);

test.skipIf(!INTEGRATION)(
  "a start deploys the CREATE2 deployer on a chain that lacks it",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain([
          "--disable-default-create2-deployer",
        ]);
        const client = publicClient(chain);
        expect(
          yield* Effect.promise(() =>
            client.getCode({ address: CREATE2_DEPLOYER }),
          ),
        ).toBeUndefined();

        const app = yield* makeApp(chain);
        const { address, migration } = yield* startAndStop(app);
        expect(migration).toBe("created");
        expect(address.toLowerCase()).toBe(
          expectedAddress(app.deployment, [
            { address: chain.account.address, role: 2 },
          ]).toLowerCase(),
        );
        expect(
          yield* Effect.promise(() =>
            client.getCode({ address: CREATE2_DEPLOYER }),
          ),
        ).toBeDefined();
        // The relayer funded exactly what the keyless transaction costs.
        expect(
          yield* Effect.promise(() =>
            client.getTransactionCount({ address: CREATE2_DEPLOYER_SENDER }),
          ),
        ).toBe(1);
        expect(
          yield* Effect.promise(() =>
            client.getBalance({ address: CREATE2_DEPLOYER_SENDER }),
          ),
        ).toBe(0n);
      }),
    ),
);

test.skipIf(!INTEGRATION)(
  "dev mode deploys like any start, from Anvil's first account",
  () =>
    run(
      Effect.gen(function* () {
        const chain = yield* startDevChain();
        const app = createTypewriterApp({
          ...solidityApp!,
          config: {
            dev: true,
            database: { url: DATABASE_URL!, maxConnections: 4 },
          },
          devChain: chain,
        });
        const { address, migration, manifest } = yield* startAndStop(app);
        expect(migration).toBe("created");
        expect(address.toLowerCase()).toBe(
          expectedAddress(app.deployment, [
            { address: chain.account.address, role: 2 },
          ]).toLowerCase(),
        );
        expect(manifest.deployment).toBe(app.deployment);
        // The dev schema is dropped when the runtime stops.
        const [{ exists }] = (yield* Effect.scoped(
          Effect.flatMap(makeDb({ url: DATABASE_URL! }), (db) =>
            db.run(
              builder.execute(
                sql`SELECT to_regnamespace(${app.schemaName}) IS NOT NULL AS exists`,
              ),
            ),
          ),
        )) as unknown as [{ exists: boolean }];
        expect(exists).toBe(false);
      }),
    ),
);
