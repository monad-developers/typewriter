import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  References,
  type Scope,
} from "effect";
import { type Hex, Secp256k1 } from "ox";
import {
  createPublicClient,
  createWalletClient,
  http,
  type LocalAccount,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import { startDevChain } from "./anvil";
import { createAccountMutation, createSigner, KeyType } from "./client";
import { createTypewriterApp, type DevChain } from "./config";
import { layerDatabase, makeDb } from "./db";
import { dropSchema } from "./db-migrate";
import { makeRelayerLedger, maxSettlementCost } from "./relayer-balance";
import { layerRpc } from "./rpc";
import { makeHttpTransport } from "./rpc-transport";
import { loadSolidityApp } from "./sol-build";
import { createTypewriterEffect } from "./typewriter";
import { MAX_PRIORITY_FEE_PER_GAS } from "./typewriter-constants";
import type { BlockEvent } from "./typewriter-types";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
const INTEGRATION = Bun.which("anvil") !== null && DATABASE_URL !== undefined;

/** Anvil's second default account, which has ether to send with. */
const FUNDED = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const BLOCK = (number: bigint) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, "0")}` as Hex.Hex,
});

test("the relayer ledger expects the balance less the fees of settlements up to the final block", () => {
  const ledger = makeRelayerLedger({ balance: 1_000n, number: 10n });
  ledger.landed(BLOCK(11n), 30n);
  ledger.landed(BLOCK(12n), 20n);
  ledger.landed(BLOCK(14n), 50n);

  // Block 14 isn't final yet.
  expect(ledger.reconcile(950n, 12n)).toEqual({
    expected: 950n,
    spent: 50n,
    difference: 0n,
  });
  // A reorg removed block 14; its settlement lands again in 15.
  ledger.removed(BLOCK(14n).hash);
  ledger.landed(BLOCK(15n), 50n);
  // A top-up of 100 since.
  expect(ledger.reconcile(1_000n, 15n)).toEqual({
    expected: 900n,
    spent: 50n,
    difference: 100n,
  });
  // Something else spent 7.
  expect(ledger.reconcile(993n, 16n).difference).toBe(-7n);
  expect(ledger.averageFee()).toBe((30n + 20n + 50n + 50n) / 4n);
});

test("a settlement of the most gas costs 30M gas at the base fee and the tip", () => {
  expect(maxSettlementCost(100_000_000_000n)).toBe(
    30_000_000n * (100_000_000_000n + MAX_PRIORITY_FEE_PER_GAS),
  );
});

const solidityApp = INTEGRATION
  ? await loadSolidityApp(ASSESSMENT_ENTRYPOINT)
  : undefined;

let deployments = 0;

type Log = {
  level: string;
  message: string;
  /** The annotations the runtime's relayer logs have. */
  annotations: {
    relayer?: unknown;
    block_number?: bigint;
    balance_wei?: bigint;
    spent_mon?: string;
    amount_wei?: bigint;
    runway_settlements?: bigint;
  };
};

/**
 * Runs `body` with a log of every message, and Anvil. Debug logs are left
 * out.
 */
const run = <a, e>(
  body: (
    logs: Log[],
    chain: DevChain,
  ) => Effect.Effect<a, e, Scope.Scope | BunServices.BunServices>,
) => {
  const logs: Log[] = [];
  const logger = Logger.make((options) => {
    const message = Array.isArray(options.message)
      ? options.message
      : [options.message];
    logs.push({
      level: options.logLevel,
      message: message.filter((part) => typeof part === "string").join(" "),
      annotations: {
        ...options.fiber.getRef(References.CurrentLogAnnotations),
      } as Log["annotations"],
    });
  });
  return Effect.gen(function* () {
    const chain = yield* startDevChain();
    return yield* body(logs, chain);
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.provide(
      Layer.merge(
        Logger.layer([logger]),
        Layer.succeed(References.MinimumLogLevel, "Info"),
      ),
    ),
    Effect.runPromise,
  );
};

/**
 * Starts the runtime on `chain` for a deployment, with Anvil's first account
 * as root and scheduler and `relayer` as relayer, checking the relayer's
 * balance at every final block.
 */
const start = (
  chain: DevChain,
  options: { deployment?: string; relayer?: LocalAccount } = {},
) =>
  Effect.gen(function* () {
    const deployment =
      options.deployment ??
      `typewriter_test_relayer_${process.pid}_${deployments++}`;
    yield* Effect.addFinalizer(() =>
      Effect.scoped(
        Effect.flatMap(makeDb({ url: DATABASE_URL! }), (db) =>
          dropSchema(db, deployment),
        ),
      ).pipe(Effect.orDie),
    );
    const app = {
      ...createTypewriterApp({
        ...solidityApp!,
        config: {
          deployment,
          root: chain.account.address,
          scheduler: chain.account,
          relayer: options.relayer ?? chain.account,
          chainId: chain.chainId,
          hardfork: chain.hardfork,
          rpcUrl: chain.rpcUrl,
          database: { url: DATABASE_URL!, maxConnections: 4 },
        },
      }),
      balanceCheckIntervalMs: 0,
    };
    const services = yield* Layer.build(
      Layer.mergeAll(
        layerRpc([makeHttpTransport(chain.rpcUrl)]),
        layerDatabase(app.database),
      ),
    );
    const typewriter = yield* createTypewriterEffect(app).pipe(
      Effect.provide(services),
    );
    return { typewriter, services, deployment };
  });

const clients = (chain: DevChain) => ({
  public: createPublicClient({ transport: http(chain.rpcUrl) }),
  wallet: (account: LocalAccount) =>
    createWalletClient({ account, transport: http(chain.rpcUrl) }),
});

/** Sends `value` from `account` to `to`, and waits for it to land. */
const transfer = (
  chain: DevChain,
  account: LocalAccount,
  to: Hex.Hex,
  value: bigint,
) =>
  Effect.promise(async () => {
    const { public: publicClient, wallet } = clients(chain);
    const hash = await wallet(account).sendTransaction({
      to,
      value,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  });

/** Polls until `logs` has a log that `match` matches, and returns it. */
const waitForLog = (logs: Log[], match: (log: Log) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const found = logs.find(match);
      if (found !== undefined) return found;
      yield* Effect.sleep("100 millis");
    }
    throw new Error("timed out waiting for a log");
  });

const balanceLogs = (logs: Log[]) =>
  logs.filter(({ message }) => message === "Relayer balance");

test.skipIf(!INTEGRATION)(
  "the runtime logs the relayer's balance, and its fees match the chain's",
  () =>
    run((logs, chain) =>
      Effect.gen(function* () {
        const { typewriter, services } = yield* start(chain);
        const program = yield* Effect.forkScoped(
          typewriter.program.pipe(Effect.provide(services)),
        );

        const [first] = balanceLogs(logs);
        expect(first!.annotations.relayer).toBe(chain.account.address);
        const startBlock = first!.annotations.block_number as bigint;
        expect(first!.annotations.balance_wei).toBe(
          yield* Effect.promise(() =>
            clients(chain).public.getBalance({
              address: chain.account.address,
              blockNumber: startBlock,
            }),
          ),
        );

        // Several settlements, each in a block of its own.
        for (let i = 0; i < 4; i++) {
          const included = yield* Deferred.make<BlockEvent<"fifo" | "batch">>();
          const off = yield* typewriter.on("block", (event) => {
            if (event.status === "included") {
              Deferred.doneUnsafe(included, Effect.succeed(event));
            }
          });
          const privateKey = Secp256k1.randomPrivateKey();
          const signer = createSigner(typewriter.manifest, {
            keyType: KeyType.Secp256k1,
            address: privateKeyToAccount(privateKey).address,
            sign: async (payload) => Secp256k1.sign({ payload, privateKey }),
          });
          yield* typewriter.execute(
            (yield* Effect.promise(() =>
              signer.signMutation(createAccountMutation(signer)),
            )) as never,
          );
          yield* Deferred.await(included).pipe(Effect.timeout("20 seconds"));
          off();
        }
        // Until a check covers the last of them.
        const lastLanded = yield* Effect.promise(() =>
          clients(chain).public.getBlockNumber(),
        );
        const last = yield* waitForLog(
          logs,
          (log) =>
            log.message === "Relayer balance" &&
            (log.annotations.block_number as bigint) >= lastLanded,
        );
        const lastBlock = last.annotations.block_number as bigint;
        const lastBalance = yield* Effect.promise(() =>
          clients(chain).public.getBalance({
            address: chain.account.address,
            blockNumber: lastBlock,
          }),
        );
        expect(last.annotations.balance_wei).toBe(lastBalance);

        // Every check matched the chain: no top-up, no stop, and what the
        // checks counted as spent is what the balance fell by.
        expect(
          logs.some((log) => log.message === "Relayer was topped up"),
        ).toBe(false);
        expect(program.pollUnsafe()).toBeUndefined();
        const spent = balanceLogs(logs)
          .slice(1)
          .filter(
            (log) => (log.annotations.block_number as bigint) <= lastBlock,
          )
          .reduce(
            (sum, log) => sum + parseEther(log.annotations.spent_mon as string),
            0n,
          );
        expect(spent).toBeGreaterThan(0n);
        expect((first!.annotations.balance_wei as bigint) - lastBalance).toBe(
          spent,
        );
        expect(
          balanceLogs(logs).some(
            (log) => log.annotations.runway_settlements !== undefined,
          ),
        ).toBe(true);
      }),
    ),
);

test.skipIf(!INTEGRATION)("the runtime logs a top-up of the relayer", () =>
  run((logs, chain) =>
    Effect.gen(function* () {
      const { typewriter, services } = yield* start(chain);
      yield* Effect.forkScoped(
        typewriter.program.pipe(Effect.provide(services)),
      );
      yield* transfer(chain, FUNDED, chain.account.address, parseEther("3"));

      const topUp = yield* waitForLog(
        logs,
        (log) => log.message === "Relayer was topped up",
      );
      expect(topUp.annotations.amount_wei).toBe(parseEther("3"));
    }),
  ),
);

test.skipIf(!INTEGRATION)(
  "the runtime stops when something else spends from the relayer's key",
  () =>
    run((logs, chain) =>
      Effect.gen(function* () {
        const { typewriter, services } = yield* start(chain);
        const program = yield* Effect.forkScoped(
          typewriter.program.pipe(Effect.provide(services)),
        );
        yield* waitForLog(logs, (log) => log.message === "Relayer balance");
        yield* transfer(chain, chain.account, FUNDED.address, 1n);

        const exit = yield* Fiber.await(program).pipe(
          Effect.timeout("30 seconds"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
          : undefined;
        const failure = (
          error as { error: { _tag: string; reason: string; message: string } }
        ).error;
        expect(failure._tag).toBe("RelayerBalanceError");
        expect(failure.reason).toBe("spentElsewhere");
        expect(failure.message).toContain(
          "something else sends from its key, so the runtime can no longer count its nonce",
        );
      }),
    ),
);

test.skipIf(!INTEGRATION)(
  "the runtime won't start when the relayer can't pay for a settlement",
  () =>
    run((_logs, chain) =>
      Effect.gen(function* () {
        // The deployment, paid for by Anvil's first account.
        const created = yield* Effect.scoped(start(chain));

        const broke = privateKeyToAccount(Secp256k1.randomPrivateKey());
        yield* transfer(chain, FUNDED, broke.address, parseEther("0.01"));
        const error = yield* Effect.scoped(
          start(chain, { deployment: created.deployment, relayer: broke }),
        ).pipe(Effect.flip);
        expect(error._tag).toBe("RelayerBalanceError");
        expect(error.message).toContain(
          `Relayer ${broke.address} has 0.01 MON`,
        );
        expect(error.message).toContain("so no settlement can land");
      }),
    ),
);
