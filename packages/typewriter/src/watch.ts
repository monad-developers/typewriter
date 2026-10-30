import { Data, Duration, Effect, Result, Schedule } from "effect";
import { Bloom, Hex } from "ox";
import { Rpc, type RpcError } from "./rpc";

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
  /** The block's logs that match `logFilter`, in order. */
  logs: LocalLog[];
};

/**
 * `Added` puts `block` on top of the chain. `Removed` takes `block`, the top,
 * off it: a reorg replaced it.
 */
export type WatchMessage =
  | { _tag: "Added"; block: LocalBlock }
  | { _tag: "Removed"; block: LocalBlock };

export type WatchConfig = {
  /** The last block the caller has seen. The watch adds each block after it. */
  fromBlock: { number: bigint; hash: Hex.Hex };
  /** The deepest reorg the watch follows. */
  maxChainDepth: number;
  pollIntervalMs: number;
  logFilter: { address: Hex.Hex; selector: Hex.Hex };
};

/** The provider returned a block without a field that a mined one has. */
export class IncompleteBlockError extends Data.TaggedError(
  "IncompleteBlockError",
)<{
  message: string;
}> {}

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
  | IncompleteBlockError
  | UnrecoverableReorgError;

/**
 * Polls the chain and passes each change after `fromBlock` to `onMessage`, in
 * order. A reorg is `Removed` for each replaced block, newest first, then
 * `Added` for each new one. Runs until it or `onMessage` fails.
 */
export function watchChain<E, R>(
  config: WatchConfig,
  onMessage: (message: WatchMessage) => Effect.Effect<void, E, R>,
): Effect.Effect<never, WatchError | E, Rpc | R> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const { address, selector } = config.logFilter;

    /**
     * The block at `number` with its logs, or `undefined` if the provider has
     * no block there, or the block left the chain before its logs were read.
     */
    const getBlock = (number: bigint) =>
      Effect.gen(function* () {
        const block = yield* rpc.request({
          method: "eth_getBlockByNumber",
          params: [Hex.fromNumber(number), false],
        });
        if (block === null) return undefined;
        // TODO(kyle) write RPC response normalizers
        if (block.hash === null || block.logsBloom === null) {
          return yield* new IncompleteBlockError({
            message: "Received block without a hash or logs bloom",
          });
        }

        let logs: LocalLog[] = [];
        // TODO(kyle) don't rely on logsBloom, it breaks on async execution chains
        if (
          Bloom.contains(block.logsBloom, address) &&
          Bloom.contains(block.logsBloom, selector)
        ) {
          const result = yield* Effect.result(
            rpc.request({
              method: "eth_getLogs",
              params: [{ blockHash: block.hash, address, topics: [selector] }],
            }),
          );
          if (Result.isFailure(result)) {
            // A node fails `eth_getLogs` for a block hash it no longer has.
            const current = yield* rpc.request({
              method: "eth_getBlockByNumber",
              params: [Hex.fromNumber(number), false],
            });
            if (current?.hash !== block.hash) return undefined;
            return yield* Effect.fail(result.failure);
          }
          logs = result.success.map((log) => ({
            topics: log.topics,
            data: log.data,
          }));
        }

        const localBlock: LocalBlock = {
          number,
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: Hex.toBigInt(block.timestamp),
          logs,
        };
        return localBlock;
      });

    /** The block before `chain`. A reorg that replaces it is unrecoverable. */
    let root = config.fromBlock;
    /** The newest `maxChainDepth` blocks, oldest first. */
    const chain: LocalBlock[] = [];

    const poll = Effect.gen(function* () {
      const latest = Hex.toBigInt(
        yield* rpc.request({ method: "eth_blockNumber" }),
      );
      while (true) {
        const tip = chain.at(-1) ?? root;
        if (tip.number >= latest) return;

        // Request the missing blocks in parallel, so the watch keeps up when a
        // block takes less time than a request.
        const count = Math.min(
          Number(latest - tip.number),
          CATCH_UP_CONCURRENCY,
        );
        const blocks = yield* Effect.forEach(
          Array.from({ length: count }, (_, i) => tip.number + 1n + BigInt(i)),
          getBlock,
          { concurrency: "unbounded" },
        );

        for (const block of blocks) {
          // The provider is behind `latest`, or the block left the chain. The
          // next poll asks again.
          if (block === undefined) return;

          const parent = chain.at(-1) ?? root;
          if (block.parentHash === parent.hash) {
            chain.push(block);
            if (chain.length > config.maxChainDepth) root = chain.shift()!;
            yield* onMessage({ _tag: "Added", block });
            continue;
          }

          // A reorg replaced the top block. The next request is for its
          // number, and compares the new block's parent with the one below.
          const removed = chain.pop();
          if (removed === undefined) {
            return yield* new UnrecoverableReorgError({
              number: block.number,
              hash: block.hash,
            });
          }
          yield* onMessage({ _tag: "Removed", block: removed });
          break;
        }
      }
    });

    return yield* Effect.repeat(
      poll,
      Schedule.spaced(Duration.millis(config.pollIntervalMs)),
    ).pipe(Effect.andThen(Effect.never));
  });
}
