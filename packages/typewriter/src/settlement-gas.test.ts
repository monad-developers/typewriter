import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, Layer, Logger, type Scope } from "effect";
import { type Hex, Secp256k1 } from "ox";
import { type LocalAccount, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import { startDevChain } from "./anvil";
import { createAccountMutation, createSigner, KeyType } from "./client";
import { createTypewriterApp, type DevChain } from "./config";
import { layerDatabase, makeDb } from "./db";
import { dropSchema } from "./db-migrate";
import { layerRpc } from "./rpc";
import { makeHttpTransport, type RpcRequest } from "./rpc-transport";
import { loadSolidityApp } from "./sol-build";
import { createTypewriterEffect } from "./typewriter";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
const INTEGRATION = Bun.which("anvil") !== null && DATABASE_URL !== undefined;

const SCHEDULER = privateKeyToAccount(`0x${"81".repeat(32)}`);
/** Mutations per wave: one, a few, and many. */
const WAVES = [1, 5, 150];

const solidityApp = INTEGRATION
  ? await loadSolidityApp(ASSESSMENT_ENTRYPOINT)
  : undefined;

let deployments = 0;

type Slack = {
  path: string;
  mutations: number;
  settlement: number;
  gasLimit: number;
  needed: number;
};

/**
 * Starts the runtime on Anvil with `scheduler` (Anvil's first account if
 * unset), stops Anvil's mining, and for each wave executes its mutations, then
 * lands each settlement in a block of its own. Returns, for each settlement,
 * its gas limit and the least gas it lands with, from `eth_estimateGas` on
 * the state right before it.
 */
const measureSlack = (path: string, scheduler?: LocalAccount) =>
  Effect.gen(function* () {
    const chain: DevChain = yield* startDevChain();
    const deployment = `typewriter_test_gas_${process.pid}_${deployments++}`;
    yield* Effect.addFinalizer(() =>
      Effect.scoped(
        Effect.flatMap(makeDb({ url: DATABASE_URL! }), (db) =>
          dropSchema(db, deployment),
        ),
      ).pipe(Effect.orDie),
    );
    const app = createTypewriterApp({
      ...solidityApp!,
      config: {
        deployment,
        root: chain.account.address,
        scheduler: scheduler ?? chain.account,
        relayer: chain.account,
        chainId: chain.chainId,
        hardfork: chain.hardfork,
        rpcUrl: chain.rpcUrl,
        database: { url: DATABASE_URL!, maxConnections: 4 },
      },
    });
    const services = yield* Layer.build(
      Layer.mergeAll(
        layerRpc([makeHttpTransport(chain.rpcUrl)]),
        layerDatabase(app.database),
      ),
    );
    const typewriter = yield* createTypewriterEffect(app).pipe(
      Effect.provide(services),
    );
    const program = yield* Effect.forkScoped(
      typewriter.program.pipe(Effect.provide(services)),
    );

    const transport = makeHttpTransport(chain.rpcUrl);
    const rpc = <result>(method: string, params: unknown[] = []) =>
      transport
        .request({ method, params } as unknown as RpcRequest)
        .pipe(Effect.orDie) as Effect.Effect<result>;
    yield* rpc("evm_setIntervalMining", [0]);

    /** The relayer's pending transactions, in nonce order. */
    const pending = Effect.map(
      rpc<{
        pending: Record<string, Record<string, { hash: Hex.Hex }>>;
      }>("txpool_content"),
      ({ pending }) =>
        Object.entries(
          Object.entries(pending).find(
            ([address]) =>
              address.toLowerCase() === chain.account.address.toLowerCase(),
          )?.[1] ?? {},
        )
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, { hash }]) => hash),
    );

    const slack: Slack[] = [];
    for (const count of WAVES) {
      const signed = yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: count }, () => {
            const privateKey = Secp256k1.randomPrivateKey();
            const signer = createSigner(typewriter.manifest, {
              keyType: KeyType.Secp256k1,
              address: privateKeyToAccount(privateKey).address,
              sign: async (payload) => Secp256k1.sign({ payload, privateKey }),
            });
            return signer.signMutation(createAccountMutation(signer));
          }),
        ),
      );
      yield* Effect.forEach(
        signed,
        (mutation) => typewriter.execute(mutation as never),
        { concurrency: "unbounded" },
      );
      // Settlements are sent once their executions are accepted.
      let hashes: Hex.Hex[] = [];
      for (let stable = 0; stable < 4; ) {
        yield* Effect.sleep("250 millis");
        const next = yield* pending;
        stable =
          next.length > 0 && next.length === hashes.length ? stable + 1 : 0;
        hashes = next;
      }
      const raws = yield* Effect.forEach(hashes, (hash) =>
        rpc<Hex.Hex>("eth_getRawTransactionByHash", [hash]),
      );
      yield* rpc("anvil_dropAllTransactions");
      for (const [i, raw] of raws.entries()) {
        const transaction = parseTransaction(raw);
        const needed = Number(
          yield* rpc<Hex.Hex>("eth_estimateGas", [
            {
              from: chain.account.address,
              to: transaction.to,
              data: transaction.data,
              accessList: transaction.accessList,
            },
            "latest",
          ]),
        );
        yield* rpc("eth_sendRawTransaction", [raw]);
        yield* rpc("evm_mine");
        const receipt = yield* rpc<{ status: Hex.Hex; gasUsed: Hex.Hex }>(
          "eth_getTransactionReceipt",
          [hashes[i]],
        );
        expect(receipt.status).toBe("0x1");
        slack.push({
          path,
          mutations: count,
          settlement: i,
          gasLimit: Number(transaction.gas),
          needed,
        });
      }
      // The runtime watches the blocks, and nothing else is pending.
      for (let i = 0; i < 4; i++) yield* rpc("evm_mine");
      yield* Effect.sleep("500 millis");
    }
    yield* Fiber.interrupt(program);
    return slack;
  });

const run = <a, e>(
  body: Effect.Effect<a, e, Scope.Scope | BunServices.BunServices>,
) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.provide(Logger.layer([])),
    Effect.runPromise,
  );

for (const [path, scheduler] of [
  ["fast path (the scheduler relays)", undefined],
  ["secp256k1 path (a relayer for the scheduler)", SCHEDULER],
] as const) {
  test.skipIf(!INTEGRATION)(
    `a settlement's gas limit covers the gas it lands with on the ${path}`,
    async () => {
      const slack = await run(measureSlack(path, scheduler));
      // biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
      if (process.env["PRINT_GAS_SLACK"]) {
        console.log(
          JSON.stringify(
            slack.map((s) => ({ ...s, slack: s.gasLimit - s.needed })),
          ),
        );
      }
      expect(slack.map(({ mutations }) => mutations)).toEqual(
        expect.arrayContaining(WAVES),
      );
      for (const { gasLimit, needed } of slack) {
        expect(gasLimit).toBeGreaterThanOrEqual(needed);
      }
    },
    120_000,
  );
}
