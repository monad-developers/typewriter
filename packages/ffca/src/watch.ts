import {
  Context,
  Duration,
  Effect,
  Layer,
  Queue,
  Schedule,
  Stream,
} from "effect";
import { Bloom, Hex } from "ox";
import type { RpcBlock } from "viem";
import { Rpc } from "./rpc";

const ZERO_LOGS_BLOOM = `0x${"0".repeat(512)}` as Hex.Hex;

export type LocalLog = {
  address: Hex.Hex;
  topics: Hex.Hex[];
  data: Hex.Hex;
  transactionHash: Hex.Hex;
  transactionIndex: number;
  logIndex: number;
};

export type LocalBlock = {
  number: bigint;
  hash: Hex.Hex;
  parentHash: Hex.Hex;
  transactions: readonly Hex.Hex[];
  logs: LocalLog[];
};

export type WatchLogFilter = {
  address: Hex.Hex;
  selector: Hex.Hex;
};

export type WatchMessage =
  | { _tag: "Extended"; block: LocalBlock }
  | {
      _tag: "Reorged";
      commonAncestor: LocalBlock | undefined;
      reorgedBlocks: LocalBlock[];
      newBlocks: LocalBlock[];
    };

export class WatchConfig extends Context.Service<
  WatchConfig,
  {
    readonly maxChainDepth: number;
    readonly pollIntervalMs: number;
    readonly logFilter?: WatchLogFilter;
  }
>()("ffca/WatchConfig") {}

export class Watch extends Context.Service<
  Watch,
  {
    readonly messages: Stream.Stream<WatchMessage>;
  }
>()("ffca/Watch") {}

const appendTip = (
  chain: readonly LocalBlock[],
  block: LocalBlock,
  maxChainDepth: number,
): readonly LocalBlock[] => {
  const trimmed = chain.length >= maxChainDepth ? chain.slice(1) : chain;
  return [...trimmed, block];
};

const appendBlocks = (
  chain: readonly LocalBlock[],
  blocks: readonly LocalBlock[],
  maxChainDepth: number,
): readonly LocalBlock[] => {
  let next = chain;
  for (const block of blocks) next = appendTip(next, block, maxChainDepth);
  return next;
};

const quantity = (value: bigint): Hex.Hex => `0x${value.toString(16)}`;

export const layerWatch: Layer.Layer<Watch, never, WatchConfig | Rpc> =
  Layer.effect(
    Watch,
    Effect.gen(function* () {
      const config = yield* WatchConfig;
      const rpc = yield* Rpc;

      const queue = yield* Effect.acquireRelease(
        Queue.unbounded<WatchMessage>(),
        (q) => Queue.shutdown(q),
      );

      // oldest first; tip is last. capped at maxChainDepth.
      let localChain: readonly LocalBlock[] = [];

      const getLocalBlockWithLogs = (block: RpcBlock) =>
        Effect.gen(function* () {
          if (
            block.number === null ||
            block.hash === null ||
            block.logsBloom === null
          ) {
            return yield* Effect.fail(
              new Error("block missing number or hash"),
            );
          }

          let logs: LocalLog[] = [];
          const filter = config.logFilter;
          if (
            filter !== undefined &&
            block.logsBloom !== ZERO_LOGS_BLOOM &&
            Bloom.contains(block.logsBloom, filter.address) &&
            Bloom.contains(block.logsBloom, filter.selector)
          ) {
            const matchingLogs = yield* rpc.request({
              method: "eth_getLogs",
              params: [
                {
                  blockHash: block.hash,
                  address: filter.address,
                  topics: [filter.selector],
                },
              ],
            });

            logs = yield* Effect.forEach(
              matchingLogs.filter((log) => log.topics[0] === filter.selector),
              (log) =>
                Effect.gen(function* () {
                  if (
                    log.transactionHash === null ||
                    log.transactionIndex === null ||
                    log.logIndex === null
                  ) {
                    return yield* Effect.fail(
                      new Error("log missing transaction hash or index"),
                    );
                  }

                  return {
                    address: log.address,
                    topics: [...log.topics],
                    data: log.data,
                    transactionHash: log.transactionHash,
                    transactionIndex: Hex.toNumber(log.transactionIndex),
                    logIndex: Hex.toNumber(log.logIndex),
                  };
                }),
            );
          }

          const localBlock: LocalBlock = {
            number: Hex.toBigInt(block.number),
            hash: block.hash,
            parentHash: block.parentHash,
            transactions: block.transactions.map((transaction) =>
              typeof transaction === "string" ? transaction : transaction.hash,
            ),
            logs,
          };
          return localBlock;
        });

      const getBlockByHash = (blockHash: Hex.Hex) =>
        Effect.gen(function* () {
          const block = yield* rpc.request({
            method: "eth_getBlockByHash",
            params: [blockHash, false],
          });
          if (block === null) {
            return yield* Effect.fail(
              new Error(`block not found: hash=${blockHash}`),
            );
          }
          return yield* getLocalBlockWithLogs(block);
        });

      const getBlockByNumber = (blockNumber: bigint) =>
        Effect.gen(function* () {
          const block = yield* rpc.request({
            method: "eth_getBlockByNumber",
            params: [quantity(blockNumber), false],
          });
          if (block === null) {
            return yield* Effect.fail(
              new Error(`block not found: number=${blockNumber}`),
            );
          }
          return yield* getLocalBlockWithLogs(block);
        });

      const reconcileReorg = (block: LocalBlock): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const originalChain = localChain;
          let reorgedBlocks = localChain.filter(
            (b) => b.number >= block.number,
          );
          let remoteBlock = block;
          const newBlocks = [block];

          localChain = localChain.filter((b) => b.number < block.number);

          while (true) {
            const parentBlock = localChain[localChain.length - 1];
            if (
              parentBlock !== undefined &&
              parentBlock.hash === remoteBlock.parentHash
            ) {
              break;
            }

            if (localChain.length === 0) {
              localChain = originalChain;
              return yield* Effect.fail(
                new Error(
                  `unrecoverable reorg beyond local chain: number=${block.number} hash=${block.hash}`,
                ),
              );
            }

            remoteBlock = yield* getBlockByHash(remoteBlock.parentHash);
            newBlocks.unshift(remoteBlock);
            reorgedBlocks = [
              localChain[localChain.length - 1]!,
              ...reorgedBlocks,
            ];
            localChain = localChain.slice(0, -1);
          }

          const commonAncestor = localChain[localChain.length - 1];
          localChain = appendBlocks(
            localChain,
            newBlocks,
            config.maxChainDepth,
          );
          yield* Queue.offer(queue, {
            _tag: "Reorged",
            commonAncestor,
            reorgedBlocks,
            newBlocks,
          });
        });

      const reconcileBlock = (
        newBlock: LocalBlock,
      ): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const current = localChain[localChain.length - 1];

          if (current === undefined) {
            localChain = appendTip(localChain, newBlock, config.maxChainDepth);
            return;
          }

          if (newBlock.hash === current.hash) {
            return;
          }

          if (current.number >= newBlock.number) {
            yield* reconcileReorg(newBlock);
            return;
          }

          if (current.number + 1n < newBlock.number) {
            for (
              let number = current.number + 1n;
              number < newBlock.number;
              number++
            ) {
              yield* reconcileBlock(yield* getBlockByNumber(number));
            }
            yield* reconcileBlock(newBlock);
            return;
          }

          if (newBlock.parentHash !== current.hash) {
            yield* reconcileReorg(newBlock);
            return;
          }

          localChain = appendTip(localChain, newBlock, config.maxChainDepth);
          yield* Queue.offer(queue, { _tag: "Extended", block: newBlock });
        });

      const poll = Effect.gen(function* () {
        const latestBlock = yield* Effect.gen(function* () {
          const block = yield* rpc.request({
            method: "eth_getBlockByNumber",
            params: ["latest", false],
          });
          if (block === null) {
            return yield* Effect.fail(new Error("latest block not found"));
          }
          return yield* getLocalBlockWithLogs(block);
        });
        yield* reconcileBlock(latestBlock);
      }).pipe(Effect.withLogSpan("watch"));

      yield* Effect.forkScoped(
        Effect.repeat(
          poll,
          Schedule.spaced(Duration.millis(config.pollIntervalMs)),
        ),
      );

      return Watch.of({ messages: Stream.fromQueue(queue) });
    }),
  );

export const layerWatchLive = (
  config: Context.Service.Shape<typeof WatchConfig>,
): Layer.Layer<Watch, never, Rpc> =>
  layerWatch.pipe(Layer.provide(Layer.succeed(WatchConfig)(config)));
