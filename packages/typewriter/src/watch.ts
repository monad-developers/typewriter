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
  logs: LocalLog[];
  /** The hashes of its transactions, in order. */
  transactions: Hex.Hex[];
};

/** A block before its logs. */
export type FetchedBlock = Omit<LocalBlock, "logs">;

/**
 * A reorg is `Removed` for each replaced block, newest first, then `Added`.
 * `Finalized` is the chain's newest finalized block, which no reorg replaces.
 * `Fetched` is a block as soon as the watch has it, before its logs. It can
 * repeat, and a block from a stale view or a reorg is never `Added`.
 */
export type WatchMessage =
  | { _tag: "Fetched"; block: FetchedBlock }
  | { _tag: "Added"; block: LocalBlock }
  | { _tag: "Removed"; block: LocalBlock }
  | { _tag: "Finalized"; block: { number: bigint; hash: Hex.Hex } };

export type WatchConfig = {
  /** The last block the caller has seen. The watch emits each block after it. */
  fromBlock: { number: bigint; hash: Hex.Hex };
  pollIntervalMs: number;
  bufferSize: number;
  /** The logs of `address` with any of `selectors` as their first topic. */
  logFilter: { address: Hex.Hex; selectors: readonly Hex.Hex[] };
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
        const { address, selectors } = config.logFilter;
        const pollInterval = Schedule.spaced(
          Duration.millis(config.pollIntervalMs),
        );

        const fetched = (block: RequestedBlock) =>
          Effect.gen(function* () {
            const fetchedBlock: FetchedBlock = {
              number: block.number,
              hash: block.hash,
              parentHash: block.parentHash,
              timestamp: block.timestamp,
              transactions: block.transactions,
            };
            yield* Queue.offer(queue, { _tag: "Fetched", block: fetchedBlock });
            return fetchedBlock;
          });

        const withLogs = (block: FetchedBlock) =>
          Effect.gen(function* () {
            const logs = yield* rpc.request({
              method: "eth_getLogs",
              params: [
                { blockHash: block.hash, address, topics: [[...selectors]] },
              ],
            });
            const localBlock: LocalBlock = {
              ...block,
              logs: logs.map((log) => ({ topics: log.topics, data: log.data })),
            };
            return localBlock;
          });

        const getBlock = (id: bigint | Hex.Hex) =>
          requestBlock(id).pipe(
            Effect.flatMap(fetched),
            Effect.flatMap(withLogs),
          );

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
            // `chain` holds every block from `root` up, so it's found by height.
            const index = Number(finalized.number - root.number) - 1;
            if (chain[index]?.hash !== finalized.hash) return;
            root = chain[index]!;
            chain = chain.slice(index + 1);
            yield* Queue.offer(queue, {
              _tag: "Finalized",
              block: { number: root.number, hash: root.hash },
            });
          });

        const poll = Effect.gen(function* () {
          const [finalized, served] = yield* Effect.all(
            [requestBlock("finalized"), requestBlock("latest")],
            { concurrency: "unbounded" },
          );
          // Providers lag each other, so `latest` can be behind `finalized`.
          const latest = finalized.number > served.number ? finalized : served;
          // A stale view can serve an orphaned block, so only a longer chain reorgs.
          if (latest.number <= tip().number) {
            yield* finalize(finalized);
            return;
          }

          const head = yield* fetched(latest);
          if (latest.number === tip().number + 1n) {
            yield* reconcile(yield* withLogs(head));
            yield* finalize(finalized);
            return;
          }

          // A window of requests in flight, in order, so a slow request holds
          // up only the blocks after it, not a whole round.
          const catchUp = Stream.iterate(tip().number + 1n, (n) => n + 1n).pipe(
            Stream.takeWhile((n) => n <= latest.number),
            Stream.mapEffect(getBlock, { concurrency: CATCH_UP_CONCURRENCY }),
            Stream.runForEach((block) =>
              reconcile(block).pipe(Effect.andThen(finalize(finalized))),
            ),
          );
          // Meanwhile the head keeps coming, since the runtime signs
          // settlements with its timestamp.
          const refreshHead = Effect.sleep(
            Duration.millis(config.pollIntervalMs),
          ).pipe(
            Effect.andThen(requestBlock("latest")),
            Effect.flatMap(fetched),
            Effect.forever,
          );
          yield* catchUp.pipe(Effect.raceFirst(refreshHead));
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
          Effect.repeat(Schedule.fixed(Duration.millis(config.pollIntervalMs))),
        );
      }),
    { bufferSize: config.bufferSize, strategy: "suspend" },
  );
}
