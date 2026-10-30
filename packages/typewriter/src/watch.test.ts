import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { Hex } from "ox";
import { Rpc } from "./rpc";
import { type RpcRequest, RpcResponseError } from "./rpc-transport";
import { type WatchConfig, type WatchMessage, watchChain } from "./watch";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SELECTOR = Hex.padLeft("0x01", 32);

const labels = new Map<Hex.Hex, string>();
/** The hash of the block that `label` names. */
const hash = (label: string) => {
  const value = Hex.padLeft(Hex.fromString(label), 32);
  labels.set(value, label);
  return value;
};

type FakeBlock = { number: number; hash: Hex.Hex; parentHash: Hex.Hex };

/** A chain from block 0, one label per block. */
const chain = (...blockLabels: string[]): FakeBlock[] =>
  blockLabels.map((label, number) => ({
    number,
    hash: hash(label),
    parentHash: hash(number === 0 ? "genesis" : blockLabels[number - 1]!),
  }));

/**
 * An `Rpc` that serves `states`, one per poll: each `latest` request moves to
 * the next state, and the last one stays. Like Anvil, it serves only the
 * blocks of the current state. Each block has one matching log, whose data is
 * the block's hash.
 */
function fakeRpc(states: FakeBlock[][]) {
  let index = -1;
  const current = () => states[Math.max(index, 0)]!;
  const format = (block: FakeBlock | undefined) =>
    block === undefined
      ? null
      : {
          number: Hex.fromNumber(block.number),
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: Hex.fromNumber(block.number),
        };

  const request = (request: RpcRequest) =>
    Effect.suspend((): Effect.Effect<unknown, RpcResponseError> => {
      if (request.method === "eth_getBlockByNumber") {
        const [id] = request.params;
        if (id === "latest") {
          index = Math.min(index + 1, states.length - 1);
          return Effect.succeed(format(current().at(-1)));
        }
        return Effect.succeed(format(current()[Number(id)]));
      }
      if (request.method === "eth_getBlockByHash") {
        const [blockHash] = request.params;
        return Effect.succeed(
          format(current().find((block) => block.hash === blockHash)),
        );
      }
      if (request.method === "eth_getLogs") {
        const [{ blockHash }] = request.params as [{ blockHash: Hex.Hex }];
        if (!current().some((block) => block.hash === blockHash)) {
          return Effect.fail(
            new RpcResponseError({
              method: "eth_getLogs",
              origin: "fake",
              status: 200,
              error: { code: -32000, message: "unknown block" },
            }),
          );
        }
        return Effect.succeed([
          { address: ADDRESS, topics: [SELECTOR], data: blockHash },
        ]);
      }
      return Effect.die(`unexpected ${request.method}`);
    });

  return Rpc.of({
    request: request as Rpc["Service"]["request"],
    requestEach: () => Effect.die("unexpected requestEach"),
  });
}

/** The first `count` messages of a watch from block 1 of `states`. */
function watch(
  states: FakeBlock[][],
  count: number,
  config: Partial<WatchConfig> = {},
) {
  return watchChain({
    fromBlock: { number: 1n, hash: hash("1") },
    maxChainDepth: 3,
    pollIntervalMs: 1,
    bufferSize: 4,
    logFilter: { address: ADDRESS, selector: SELECTOR },
    ...config,
  }).pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.provideService(Rpc, fakeRpc(states)),
  );
}

/** `message` as "Added 3", and checks that its logs are its block's. */
function describe(message: WatchMessage) {
  expect(message.block.logs).toEqual([
    { topics: [SELECTOR], data: message.block.hash },
  ]);
  return `${message._tag} ${labels.get(message.block.hash)}`;
}

const run = async (...args: Parameters<typeof watch>) =>
  Array.from(await Effect.runPromise(watch(...args))).map(describe);

test("adds the blocks after fromBlock, also when it starts behind", async () => {
  expect(await run([chain("0", "1", "2", "3")], 2)).toEqual([
    "Added 2",
    "Added 3",
  ]);
});

test("replaces a tip that a block at the same height replaced", async () => {
  expect(
    await run([chain("0", "1", "2", "3"), chain("0", "1", "2", "3b")], 4),
  ).toEqual(["Added 2", "Added 3", "Removed 3", "Added 3b"]);
});

test("replaces several blocks, newest first, then adds theirs", async () => {
  expect(
    await run(
      [chain("0", "1", "2", "3", "4"), chain("0", "1", "2", "3b", "4b")],
      7,
    ),
  ).toEqual([
    "Added 2",
    "Added 3",
    "Added 4",
    "Removed 4",
    "Removed 3",
    "Added 3b",
    "Added 4b",
  ]);
});

test("removes blocks when the chain gets shorter", async () => {
  expect(
    await run([chain("0", "1", "2", "3", "4"), chain("0", "1", "2", "3b")], 6),
  ).toEqual([
    "Added 2",
    "Added 3",
    "Added 4",
    "Removed 4",
    "Removed 3",
    "Added 3b",
  ]);
});

test("follows a reorg below its top while it catches up", async () => {
  expect(
    await run(
      [chain("0", "1", "2", "3"), chain("0", "1", "2", "3b", "4b", "5b")],
      6,
    ),
  ).toEqual([
    "Added 2",
    "Added 3",
    "Removed 3",
    "Added 3b",
    "Added 4b",
    "Added 5b",
  ]);
});

test("ignores a provider whose latest block it already has", async () => {
  expect(
    await run(
      [
        chain("0", "1", "2", "3"),
        chain("0", "1", "2"),
        chain("0", "1", "2", "3", "4"),
      ],
      3,
    ),
  ).toEqual(["Added 2", "Added 3", "Added 4"]);
});

test("changes nothing when a block leaves the chain during a reorg", async () => {
  // `4x` builds on `3x`, which the provider no longer has.
  const orphan = {
    number: 4,
    hash: hash("4x"),
    parentHash: hash("3x"),
  };
  expect(
    await run(
      [
        chain("0", "1", "2", "3"),
        [...chain("0", "1", "2", "3"), orphan],
        chain("0", "1", "2", "3", "4"),
      ],
      3,
    ),
  ).toEqual(["Added 2", "Added 3", "Added 4"]);
});

test("follows a reorg as deep as maxChainDepth", async () => {
  expect(
    await run(
      [chain("0", "1", "2", "3", "4"), chain("0", "1", "2", "3b", "4b")],
      7,
      { maxChainDepth: 2 },
    ),
  ).toEqual([
    "Added 2",
    "Added 3",
    "Added 4",
    "Removed 4",
    "Removed 3",
    "Added 3b",
    "Added 4b",
  ]);
});

test("fails on a reorg deeper than maxChainDepth", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      watch(
        [chain("0", "1", "2", "3", "4"), chain("0", "1", "2b", "3b", "4b")],
        10,
        { maxChainDepth: 2 },
      ),
    ),
  );
  expect(error._tag).toBe("UnrecoverableReorgError");
});
