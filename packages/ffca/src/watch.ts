import {
  Context,
  Duration,
  Effect,
  Layer,
  Queue,
  Schedule,
  Stream,
} from "effect";
import type { Hex } from "ox";
import { createPublicClient, extractChain, http } from "viem";
import * as chains from "viem/chains";

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MAX_CHAIN_DEPTH = 64;

export type LocalBlock = {
  number: bigint;
  hash: Hex.Hex;
  parentHash: Hex.Hex;
};

export type WatchMessage =
  | { _tag: "Extended"; block: LocalBlock }
  | {
      _tag: "Reorged";
      commonAncestor: LocalBlock | undefined;
      reorgedBlocks: LocalBlock[];
      newBlocks: LocalBlock[];
    };

export class WatchConfig extends Context.Tag("ffca/WatchConfig")<
  WatchConfig,
  {
    readonly chainId: number;
    readonly rpcUrl: string | readonly string[];
    readonly pollIntervalMs?: number;
    readonly maxChainDepth?: number;
  }
>() {}

export class Watch extends Context.Tag("ffca/Watch")<
  Watch,
  {
    readonly messages: Stream.Stream<WatchMessage>;
  }
>() {}

const toLocalBlock = (block: {
  number: bigint | null;
  hash: Hex.Hex | null;
  parentHash: Hex.Hex;
}): LocalBlock => {
  if (block.number === null || block.hash === null) {
    throw new Error("block missing number or hash");
  }
  return {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
  };
};

const appendTip = (
  chain: readonly LocalBlock[],
  block: LocalBlock,
  maxChainDepth: number,
): readonly LocalBlock[] => {
  const trimmed = chain.length >= maxChainDepth ? chain.slice(1) : chain;
  return [...trimmed, block];
};

export const layerWatch: Layer.Layer<Watch, never, WatchConfig> = Layer.scoped(
  Watch,
  Effect.gen(function* () {
    const config = yield* WatchConfig;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxChainDepth = config.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;

    const rpcUrl = Array.isArray(config.rpcUrl)
      ? config.rpcUrl[0]
      : config.rpcUrl;
    // viem's `extractChain` is typed with a literal union; cast through at
    // the framework boundary.
    const chain = extractChain({
      chains: Object.values(chains),
      id: config.chainId as 1,
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, { retryCount: 0 }),
    });

    const queue = yield* Effect.acquireRelease(
      Queue.unbounded<WatchMessage>(),
      (q) => Queue.shutdown(q),
    );

    // oldest first; tip is last. capped at maxChainDepth.
    let localChain: readonly LocalBlock[] = [];

    const reconcileBlock = (newBlock: LocalBlock): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const current = localChain[localChain.length - 1];

        if (current === undefined) {
          localChain = appendTip(localChain, newBlock, maxChainDepth);
          return;
        }

        if (newBlock.hash === current.hash) {
          return;
        }

        if (newBlock.number > current.number + 1n) {
          for (
            let number = current.number + 1n;
            number < newBlock.number;
            number++
          ) {
            const missingBlock = yield* Effect.tryPromise({
              try: () =>
                publicClient
                  .getBlock({ blockNumber: number })
                  .then(toLocalBlock),
              catch: (error) => error as Error,
            });
            yield* reconcileBlock(missingBlock);
          }
          yield* reconcileBlock(newBlock);
          return;
        }

        if (
          newBlock.number === current.number + 1n &&
          newBlock.parentHash === current.hash
        ) {
          localChain = appendTip(localChain, newBlock, maxChainDepth);
          yield* Queue.offer(queue, { _tag: "Extended", block: newBlock });
          return;
        }

        let cursor: Hex.Hex = newBlock.parentHash;
        let cursorNumber = newBlock.number - 1n;
        let commonAncestor: LocalBlock | undefined;
        const oldest = localChain[0]?.number ?? 0n;

        while (cursorNumber >= oldest) {
          const local = localChain.find(
            (block) => block.number === cursorNumber,
          );
          if (local !== undefined && local.hash === cursor) {
            commonAncestor = local;
            break;
          }
          if (cursorNumber === 0n) break;
          const remote = yield* Effect.tryPromise({
            try: () =>
              publicClient.getBlock({ blockHash: cursor }).then(toLocalBlock),
            catch: (error) => error as Error,
          });
          cursor = remote.parentHash;
          cursorNumber -= 1n;
        }

        const ancestorIndex =
          commonAncestor === undefined
            ? -1
            : localChain.findIndex(
                (block) => block.number === commonAncestor.number,
              );
        const reorgedBlocks =
          ancestorIndex === -1
            ? [...localChain]
            : localChain.slice(ancestorIndex + 1);
        const truncated =
          ancestorIndex === -1 ? [] : localChain.slice(0, ancestorIndex + 1);

        localChain = appendTip(truncated, newBlock, maxChainDepth);
        yield* Queue.offer(queue, {
          _tag: "Reorged",
          commonAncestor,
          reorgedBlocks,
          newBlocks: [newBlock],
        });
      });

    const poll = Effect.gen(function* () {
      const latestBlock = yield* Effect.tryPromise({
        try: () =>
          publicClient.getBlock({ blockTag: "latest" }).then(toLocalBlock),
        catch: (error) => error as Error,
      });
      yield* reconcileBlock(latestBlock);
    }).pipe(Effect.withLogSpan("watch"));

    yield* Effect.forkScoped(
      Effect.repeat(poll, Schedule.spaced(Duration.millis(pollIntervalMs))),
    );

    return Watch.of({
      messages: Stream.fromQueue(queue),
    });
  }),
);

export const layerWatchLive = (
  config: Context.Tag.Service<WatchConfig>,
): Layer.Layer<Watch> =>
  layerWatch.pipe(Layer.provide(Layer.succeed(WatchConfig, config)));
