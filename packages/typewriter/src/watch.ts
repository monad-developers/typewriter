import { Data, Duration, Effect, Queue, Schedule, Stream } from "effect";
import type { Hex } from "ox";
import { Rpc, type RpcError } from "./rpc";
import { type RequestedBlock, requestBlock } from "./rpc-request";

/** How many blocks the watch requests at once when it falls behind. */
const CATCH_UP_CONCURRENCY = 25;

export type LocalLog = {
  topics: [] | [signature: Hex.Hex, ...args: Hex.Hex[]];
  data: Hex.Hex;
};

export type LocalBlock = {
  number: bigint;
  hash: Hex.Hex;
  parentHash: Hex.Hex;
  timestamp: bigint;
  baseFeePerGas: bigint;
  logs: LocalLog[];
  /** The hashes of its transactions, in order. */
  transactions: Hex.Hex[];
};

/**
 * A reorg is `Removed` for each replaced block, newest first, then `Added`.
 * `Finalized` is the chain's newest finalized block, which no reorg replaces.
 */
export type WatchMessage =
  | { _tag: "Added"; block: LocalBlock }
  | { _tag: "Removed"; block: LocalBlock }
  | { _tag: "Finalized"; block: { number: bigint; hash: Hex.Hex } };

export type WatchConfig = {
  /** The last block the caller has seen. The watch emits each block after it. */
  fromBlock: { number: bigint; hash: Hex.Hex };
  pollIntervalMs: number;
  bufferSize: number;
  logFilter: { address: Hex.Hex; selector: Hex.Hex };
  /** Called with each newest block the watch requests, before it catches up to it. */
  onLatest: (block: {
    number: bigint;
    timestamp: bigint;
    baseFeePerGas: bigint | null;
  }) => void;
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

/** A provider served a block off the finalized chain, from a stale view. */
class StaleBlockError extends Data.TaggedError("StaleBlockError")<{
  number: bigint;
  hash: Hex.Hex;
}> {
  override get message() {
    return `Block ${this.number} (${this.hash}) does not descend from the finalized block`;
  }
}

export type WatchError = RpcError | UnrecoverableReorgError;

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
              baseFeePerGas: block.baseFeePerGas ?? 0n,
              logs: logs.map((log) => ({ topics: log.topics, data: log.data })),
              transactions: block.transactions,
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
                const error = { number: top.number, hash: top.hash };
                // No reorg replaces a finalized root, so `top` is from a stale view.
                return yield* root === config.fromBlock
                  ? new UnrecoverableReorgError(error)
                  : new StaleBlockError(error);
              }
              removed.push(replaced);
              added.unshift(yield* getBlock(added[0]!.parentHash));
            }

            chain = [...kept, ...added];
            for (const block of removed) {
              yield* Queue.offer(queue, { _tag: "Removed", block });
            }
            for (const block of added) {
              yield* Queue.offer(queue, { _tag: "Added", block });
            }
          });

        const finalize = (finalized: RequestedBlock) =>
          Effect.gen(function* () {
            // A provider ahead of the one that served `latest`, or a chain
            // that a reorg has yet to replace, is one a later poll reaches.
            const index = chain.findIndex(
              (block) => block.hash === finalized.hash,
            );
            if (index === -1) return;
            root = chain[index]!;
            chain = chain.slice(index + 1);
            yield* Queue.offer(queue, {
              _tag: "Finalized",
              block: { number: root.number, hash: root.hash },
            });
          });

        const poll = Effect.gen(function* () {
          // Requested before `latest`, so the chain up to `latest` has it.
          const finalized = yield* requestBlock("finalized");
          const latest = yield* requestBlock("latest");
          config.onLatest(latest);
          // A stale view can serve an orphaned block, so only a longer chain reorgs.
          if (latest.number <= tip().number) {
            yield* finalize(finalized);
            return;
          }

          if (latest.number === tip().number + 1n) {
            yield* reconcile(yield* withLogs(latest));
            yield* finalize(finalized);
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
            yield* finalize(finalized);
            if (tip().number < latest.number) {
              config.onLatest(yield* requestBlock("latest"));
            }
          }
        });

        yield* poll.pipe(
          Effect.catchTag("StaleBlockError", (error) =>
            Effect.logWarning("Ignored a stale view of the chain", error),
          ),
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
