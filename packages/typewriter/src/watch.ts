import { Data, Duration, Effect, Queue, Schedule, Stream } from "effect";
import type { Hex } from "ox";
import { Rpc, type RpcError } from "./rpc";
import {
  type BlockNotFoundError,
  type RequestedBlock,
  requestBlock,
} from "./rpc-request";

/** How many blocks the watch requests at once when it falls behind. */
const CATCH_UP_CONCURRENCY = 16;

export type LocalLog = {
  topics: [] | [signature: Hex.Hex, ...args: Hex.Hex[]];
  data: Hex.Hex;
};

export type LocalBlock = {
  number: bigint;
  hash: Hex.Hex;
  parentHash: Hex.Hex;
  timestamp: bigint;
  logs: LocalLog[];
};

/** A reorg is `Removed` for each replaced block, newest first, then `Added`. */
export type WatchMessage =
  | { _tag: "Added"; block: LocalBlock }
  | { _tag: "Removed"; block: LocalBlock };

export type WatchConfig = {
  /** The last block the caller has seen. The watch emits each block after it. */
  fromBlock: { number: bigint; hash: Hex.Hex };
  maxChainDepth: number;
  pollIntervalMs: number;
  bufferSize: number;
  logFilter: { address: Hex.Hex; selector: Hex.Hex };
};

/** The chain reorged deeper than the blocks the watch keeps. */
export class UnrecoverableReorgError extends Data.TaggedError(
  "UnrecoverableReorgError",
)<{
  number: bigint;
  hash: Hex.Hex;
}> {
  override get message() {
    return `Detected unrecoverable reorg deeper than the local chain at block ${this.number} (${this.hash})`;
  }
}

export type WatchError =
  | RpcError
  | BlockNotFoundError
  | UnrecoverableReorgError;

export function watchChain(
  config: WatchConfig,
): Stream.Stream<WatchMessage, WatchError, Rpc> {
  return Stream.callback<WatchMessage, WatchError, Rpc>(
    (queue) =>
      Effect.gen(function* () {
        const rpc = yield* Rpc;
        const { address, selector } = config.logFilter;
        const pollInterval = Schedule.spaced(
          Duration.millis(config.pollIntervalMs),
        );

        const withLogs = (block: RequestedBlock) =>
          Effect.gen(function* () {
            const logs = yield* rpc.request({
              method: "eth_getLogs",
              params: [{ blockHash: block.hash, address, topics: [selector] }],
            });
            const localBlock: LocalBlock = {
              number: block.number,
              hash: block.hash,
              parentHash: block.parentHash,
              timestamp: block.timestamp,
              logs: logs.map((log) => ({ topics: log.topics, data: log.data })),
            };
            return localBlock;
          });

        const getBlock = (id: bigint | Hex.Hex) =>
          requestBlock(id).pipe(Effect.flatMap(withLogs));

        /** The block below `chain`. A reorg that replaces it is unrecoverable. */
        let root = config.fromBlock;
        let chain: LocalBlock[] = [];
        const tip = () => chain.at(-1) ?? root;

        /** Puts `top` on the chain, removing the blocks a reorg replaced. */
        const reconcile = (top: LocalBlock) =>
          Effect.gen(function* () {
            const kept = chain.filter((block) => block.number < top.number);
            const removed = chain
              .filter((block) => block.number >= top.number)
              .reverse();
            const added = [top];
            while (added[0]!.parentHash !== (kept.at(-1) ?? root).hash) {
              const replaced = kept.pop();
              if (replaced === undefined) {
                return yield* new UnrecoverableReorgError({
                  number: top.number,
                  hash: top.hash,
                });
              }
              removed.push(replaced);
              added.unshift(yield* getBlock(added[0]!.parentHash));
            }

            chain = [...kept, ...added];
            while (chain.length > config.maxChainDepth) root = chain.shift()!;
            for (const block of removed) {
              yield* Queue.offer(queue, { _tag: "Removed", block });
            }
            for (const block of added) {
              yield* Queue.offer(queue, { _tag: "Added", block });
            }
          });

        const poll = Effect.gen(function* () {
          const latest = yield* requestBlock("latest");
          if (
            latest.number <= root.number ||
            chain.some((block) => block.hash === latest.hash)
          ) {
            return;
          }

          if (latest.number <= tip().number + 1n) {
            yield* reconcile(yield* withLogs(latest));
            return;
          }

          while (tip().number < latest.number) {
            const start = tip().number + 1n;
            const count = Math.min(
              Number(latest.number - start) + 1,
              CATCH_UP_CONCURRENCY,
            );
            const blocks = yield* Effect.forEach(
              Array.from({ length: count }, (_, i) => start + BigInt(i)),
              getBlock,
              { concurrency: "unbounded" },
            );
            for (const block of blocks) yield* reconcile(block);
          }
        });

        yield* poll.pipe(
          // A block can leave the chain between requests. `reconcile` changes
          // nothing until it succeeds, so the next poll starts over.
          Effect.tapError((error) =>
            Effect.logWarning("Failed to poll the chain", error),
          ),
          Effect.retry({
            while: (error) => error._tag !== "UnrecoverableReorgError",
            schedule: pollInterval,
          }),
          Effect.repeat(pollInterval),
        );
      }),
    { bufferSize: config.bufferSize, strategy: "suspend" },
  );
}
