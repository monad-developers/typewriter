import { expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import { anvil } from "viem/chains";
import {
  TEST_CLIENT,
  TEST_PUBLIC_CLIENT,
  TEST_RPC_URL,
  TEST_WALLET_CLIENT,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  COUNTER_ABI,
  COUNTER_MUTATIONS,
  deployCounter,
  signCounter,
} from "../test/utils";
import { encodeMutationCalldata } from "./encoding";
import { layerRpcLive } from "./rpc";
import { layerWatchLive, Watch, type WatchMessage } from "./watch";

const POLL_INTERVAL_MS = 50;

const liveLayer = () =>
  layerWatchLive({
    pollIntervalMs: POLL_INTERVAL_MS,
    maxChainDepth: 16,
  }).pipe(Layer.provide(layerRpcLive({ rpcUrl: TEST_RPC_URL })));

const FORCE_INCLUSION_QUEUED_EVENT = parseAbiItem(
  "event ForceInclusionQueued(uint256 index, uint8 mutation, bytes mutationData, (uint8 keyType, bytes publicKey, bytes rawSignature) sig, uint256 enqueuedBlock)",
);

const collect = (
  stream: Stream.Stream<WatchMessage>,
  n: number,
  timeoutMs = 2000,
): Effect.Effect<readonly WatchMessage[]> =>
  stream.pipe(
    Stream.take(n),
    Stream.runCollect,
    Effect.timeout(`${timeoutMs} millis`),
    Effect.orDie,
  );

// Wait a bit longer than one poll interval so the watcher observes the cold
// start before we start mining. Without this the first mined block can land
// before the watcher's first poll, and the test sees that block as the seed
// rather than as an Extended message.
const settleColdStart = Effect.sleep(`${POLL_INTERVAL_MS * 2} millis`);

test("extends local chain when anvil mines a new block", async () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const watch = yield* Watch;
      yield* settleColdStart;
      const transactionHash = yield* Effect.promise(() =>
        TEST_WALLET_CLIENT.sendTransaction({
          account: TEST_WALLET_CLIENT.account!,
          chain: anvil,
          to: USER_ACCOUNT.address,
          value: 1n,
        }),
      );
      return { messages: yield* collect(watch.messages, 1), transactionHash };
    }).pipe(Effect.provide(liveLayer())),
  );

  const { messages, transactionHash } = await Effect.runPromise(program);

  expect(messages.map((message) => message._tag)).toMatchInlineSnapshot(`
    [
      "Extended",
    ]
  `);
  if (messages[0]!._tag !== "Extended") {
    throw new Error(`expected Extended, got ${messages[0]!._tag}`);
  }
  expect(messages[0]!.block.transactions).toContain(transactionHash);
  expect(messages[0]!.block.logs).toMatchInlineSnapshot(`[]`);
});

test("fetches skipped blocks and emits each extension", async () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const watch = yield* Watch;
      yield* settleColdStart;
      yield* Effect.promise(() => TEST_CLIENT.mine({ blocks: 3 }));
      return yield* collect(watch.messages, 3);
    }).pipe(Effect.provide(liveLayer())),
  );

  const messages = await Effect.runPromise(program);

  expect(messages.map((message) => message._tag)).toMatchInlineSnapshot(`
    [
      "Extended",
      "Extended",
      "Extended",
    ]
  `);
  const blocks = messages.map((message) => {
    if (message._tag !== "Extended") {
      throw new Error(`expected Extended, got ${message._tag}`);
    }
    return message.block;
  });
  expect(blocks.map((block) => block.number)).toMatchInlineSnapshot(
    [blocks[0]!.number, blocks[0]!.number + 1n, blocks[0]!.number + 2n],
    `
    [
      1n,
      2n,
      3n,
    ]
  `,
  );
});

test("emits no message when no new blocks are mined", async () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const watch = yield* Watch;
      return yield* watch.messages.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption(`${POLL_INTERVAL_MS * 4} millis`),
      );
    }).pipe(Effect.provide(liveLayer())),
  );

  const result = await Effect.runPromise(program);
  expect(result._tag).toMatchInlineSnapshot(`"None"`);
});

test("attaches matching force inclusion enqueue logs", async () => {
  const counterAddress = await deployCounter(USER_ACCOUNT.address);
  const amount = 5n;
  const nonce = 0n;
  const signature = signCounter({
    privateKey: USER_PRIVATE_KEY,
    amount,
    nonce,
    address: counterAddress,
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

  const program = Effect.scoped(
    Effect.gen(function* () {
      const watch = yield* Watch;
      yield* settleColdStart;
      const transactionHash = yield* Effect.promise(() =>
        TEST_WALLET_CLIENT.writeContract({
          account: TEST_WALLET_CLIENT.account!,
          chain: anvil,
          address: counterAddress,
          abi: COUNTER_ABI,
          functionName: "enqueue",
          args: [COUNTER_MUTATIONS.add.tag, mutationData, signature],
        }),
      );
      return { messages: yield* collect(watch.messages, 1), transactionHash };
    }).pipe(
      Effect.provide(
        layerWatchLive({
          pollIntervalMs: POLL_INTERVAL_MS,
          maxChainDepth: 16,
          logFilter: {
            address: counterAddress,
            selector: toEventSelector(FORCE_INCLUSION_QUEUED_EVENT),
          },
        }).pipe(Layer.provide(layerRpcLive({ rpcUrl: TEST_RPC_URL }))),
      ),
    ),
  );

  const { messages, transactionHash } = await Effect.runPromise(program);
  const message = messages[0]!;
  if (message._tag !== "Extended") {
    throw new Error(`expected Extended, got ${message._tag}`);
  }

  expect(message.block.logs.length).toMatchInlineSnapshot(`1`);
  const log = message.block.logs[0]!;
  expect(log.transactionHash).toBe(transactionHash);
  expect(log.topics.length).toMatchInlineSnapshot(`1`);

  const decoded = decodeEventLog({
    abi: [FORCE_INCLUSION_QUEUED_EVENT],
    eventName: "ForceInclusionQueued",
    data: log.data,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  const args = decoded.args as {
    index: bigint;
    mutation: number;
    mutationData: typeof mutationData;
    sig: typeof signature;
    enqueuedBlock: bigint;
  };

  expect(args.index).toMatchInlineSnapshot(`0n`);
  expect(args.mutation).toMatchInlineSnapshot(`0`);
  expect(args.mutationData).toBe(mutationData);
  expect(args.sig).toEqual(signature);
  expect(args.enqueuedBlock).toBe(message.block.number);
});

test("emits Reorged with the full replacement path", async () => {
  // Anvil's revert rolls state back to a snapshot; mining after that produces
  // a different tip at the same height. From the watcher's perspective that's
  // a reorg — same number, different hash, different parent chain.
  const program = Effect.scoped(
    Effect.gen(function* () {
      const watch = yield* Watch;

      // Snapshot the pre-reorg state, then mine several blocks to give the
      // watcher a segment it'll later need to roll back from.
      yield* settleColdStart;
      const snapshotId = yield* Effect.promise(() => TEST_CLIENT.snapshot());
      yield* Effect.promise(() => TEST_CLIENT.mine({ blocks: 3 }));

      // Wait for the watcher to observe the whole pre-reorg segment, otherwise
      // its local tip is still the pre-mine block and the revert is a no-op.
      const beforeReorg = yield* collect(watch.messages, 3);

      // Revert and mine a fresh segment at the same height. anvil bumps the
      // timestamp on each mine, so the replacement hashes differ.
      yield* Effect.promise(() => TEST_CLIENT.revert({ id: snapshotId }));
      yield* Effect.promise(() => TEST_CLIENT.mine({ blocks: 3 }));

      const afterReorg = yield* collect(watch.messages, 1);

      const latest = yield* Effect.promise(() =>
        TEST_PUBLIC_CLIENT.getBlock({ blockTag: "latest" }),
      );

      return { beforeReorg, afterReorg, latestHash: latest.hash };
    }).pipe(Effect.provide(liveLayer())),
  );

  const { beforeReorg, afterReorg, latestHash } =
    await Effect.runPromise(program);

  expect(beforeReorg.map((message) => message._tag)).toMatchInlineSnapshot(`
    [
      "Extended",
      "Extended",
      "Extended",
    ]
  `);
  const reorg = afterReorg[0]!;
  if (reorg._tag !== "Reorged") {
    throw new Error(`expected Reorged, got ${reorg._tag}`);
  }
  expect({
    reorgedBlocks: reorg.reorgedBlocks.length,
    newBlocks: reorg.newBlocks.length,
    newTipMatchesLatest: reorg.newBlocks[2]!.hash === latestHash,
    newBlockNumberDeltas: reorg.newBlocks.map(
      (block) => block.number - reorg.newBlocks[0]!.number,
    ),
  }).toMatchInlineSnapshot(`
    {
      "newBlockNumberDeltas": [
        0n,
        1n,
        2n,
      ],
      "newBlocks": 3,
      "newTipMatchesLatest": true,
      "reorgedBlocks": 3,
    }
  `);
  // The first reorged block's parent was the common ancestor, so the watcher
  // should have found it without falling off the local chain.
  expect(reorg.commonAncestor).not.toBeUndefined();
});
