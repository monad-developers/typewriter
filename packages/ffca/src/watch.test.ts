import { expect, test } from "bun:test";
import { Chunk, Effect, Stream } from "effect";
import { anvil } from "viem/chains";
import { TEST_CLIENT, TEST_PUBLIC_CLIENT, TEST_RPC_URL } from "../test/setup";
import { layerWatchLive, Watch, type WatchMessage } from "./watch";

const POLL_INTERVAL_MS = 50;

const liveLayer = () =>
  layerWatchLive({
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxChainDepth: 16,
  });

const collect = (
  stream: Stream.Stream<WatchMessage>,
  n: number,
  timeoutMs = 2000,
): Effect.Effect<readonly WatchMessage[]> =>
  stream.pipe(
    Stream.take(n),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () => new Error(`collect timed out waiting for ${n} messages`),
    }),
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
      yield* Effect.promise(() => TEST_CLIENT.mine({ blocks: 1 }));
      return yield* collect(watch.messages, 1);
    }).pipe(Effect.provide(liveLayer())),
  );

  const messages = await Effect.runPromise(program);

  expect(messages.length).toBe(1);
  expect(messages[0]!._tag).toBe("Extended");
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

  expect(messages.map((message) => message._tag)).toEqual([
    "Extended",
    "Extended",
    "Extended",
  ]);
  const blocks = messages.map((message) => {
    if (message._tag !== "Extended") {
      throw new Error(`expected Extended, got ${message._tag}`);
    }
    return message.block;
  });
  expect(blocks.map((block) => block.number)).toEqual([
    blocks[0]!.number,
    blocks[0]!.number + 1n,
    blocks[0]!.number + 2n,
  ]);
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
  expect(result._tag).toBe("None");
});

test("emits Reorged when anvil reverts to a snapshot and mines a different block", async () => {
  // Anvil's revert rolls state back to a snapshot; mining after that produces
  // a different tip at the same height. From the watcher's perspective that's
  // a reorg — same number, different hash, different parent chain.
  const program = Effect.scoped(
    Effect.gen(function* () {
      const watch = yield* Watch;

      // Snapshot the pre-reorg state, then mine one block to give the watcher
      // a tip it'll later need to roll back from.
      yield* settleColdStart;
      const snapshotId = yield* Effect.promise(() => TEST_CLIENT.snapshot());
      yield* Effect.promise(() => TEST_CLIENT.mine({ blocks: 1 }));

      // Wait for the watcher to observe the Extended event, otherwise its
      // local tip is still the pre-mine block and the revert is a no-op.
      const beforeReorg = yield* collect(watch.messages, 1);

      // Revert and mine a fresh block at the same height. anvil bumps the
      // timestamp on each mine, so the new block hash differs.
      yield* Effect.promise(() => TEST_CLIENT.revert({ id: snapshotId }));
      yield* Effect.promise(() => TEST_CLIENT.mine({ blocks: 1 }));

      const afterReorg = yield* collect(watch.messages, 1);

      const latest = yield* Effect.promise(() =>
        TEST_PUBLIC_CLIENT.getBlock({ blockTag: "latest" }),
      );

      return { beforeReorg, afterReorg, latestHash: latest.hash };
    }).pipe(Effect.provide(liveLayer())),
  );

  const { beforeReorg, afterReorg, latestHash } =
    await Effect.runPromise(program);

  expect(beforeReorg[0]!._tag).toBe("Extended");
  const reorg = afterReorg[0]!;
  if (reorg._tag !== "Reorged") {
    throw new Error(`expected Reorged, got ${reorg._tag}`);
  }
  expect(reorg.reorgedBlocks.length).toBe(1);
  expect(reorg.newBlocks.length).toBe(1);
  expect(reorg.newBlocks[0]!.hash).toBe(latestHash);
  // The first reorged block's parent was the common ancestor, so the watcher
  // should have found it without falling off the local chain.
  expect(reorg.commonAncestor).not.toBeUndefined();
});
