import {
  Data,
  Duration,
  Effect,
  Queue,
  Result,
  Schedule,
  Stream,
} from "effect";
import { Hex } from "ox";
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

/** A block before its logs are read. */
type Header = Omit<LocalBlock, "logs">;

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
  /** How many messages the watch reads ahead of its consumer. */
  bufferSize: number;
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
 * Polls the chain and streams each change after `fromBlock`, in order. A reorg
 * is `Removed` for each replaced block, newest first, then `Added` for each new
 * one. The watch reads up to `bufferSize` messages ahead of the consumer.
 */
export function watchChain(
  config: WatchConfig,
): Stream.Stream<WatchMessage, WatchError, Rpc> {
  return Stream.callback<WatchMessage, WatchError, Rpc>(
    (queue) =>
      Effect.gen(function* () {
        const rpc = yield* Rpc;
        const { address, selector } = config.logFilter;

        /** The block that `id` names, or `undefined` if the provider has none. */
        const getHeader = (id: bigint | Hex.Hex | "latest") =>
          Effect.gen(function* () {
            const block =
              typeof id === "bigint" || id === "latest"
                ? yield* rpc.request({
                    method: "eth_getBlockByNumber",
                    params: [
                      typeof id === "bigint" ? Hex.fromNumber(id) : id,
                      false,
                    ],
                  })
                : yield* rpc.request({
                    method: "eth_getBlockByHash",
                    params: [id, false],
                  });
            if (block === null) return undefined;
            // TODO(kyle) write RPC response normalizers
            if (block.number === null || block.hash === null) {
              return yield* new IncompleteBlockError({
                message: "Received block without a number or hash",
              });
            }
            const header: Header = {
              number: Hex.toBigInt(block.number),
              hash: block.hash,
              parentHash: block.parentHash,
              timestamp: Hex.toBigInt(block.timestamp),
            };
            return header;
          });

        /**
         * `header` with its logs, or `undefined` if the block left the chain
         * before its logs were read.
         */
        const withLogs = (header: Header) =>
          Effect.gen(function* () {
            const result = yield* Effect.result(
              rpc.request({
                method: "eth_getLogs",
                params: [
                  { blockHash: header.hash, address, topics: [selector] },
                ],
              }),
            );
            if (Result.isFailure(result)) {
              // A node fails `eth_getLogs` for a block hash it doesn't have.
              if ((yield* getHeader(header.hash)) === undefined) {
                return undefined;
              }
              return yield* Effect.fail(result.failure);
            }
            const block: LocalBlock = {
              ...header,
              logs: result.success.map((log) => ({
                topics: log.topics,
                data: log.data,
              })),
            };
            return block;
          });

        /**
         * The block at `number` with its logs, or `undefined` if the provider
         * has none, or the block left the chain before its logs were read.
         */
        const getBlock = (number: bigint) =>
          Effect.gen(function* () {
            const header = yield* getHeader(number);
            return header === undefined ? undefined : yield* withLogs(header);
          });

        /** The block below `chain`. A reorg that replaces it is unrecoverable. */
        let root = config.fromBlock;
        /** The blocks above `root`, oldest first, at most `maxChainDepth`. */
        let chain: LocalBlock[] = [];
        const tip = () => chain.at(-1) ?? root;

        /**
         * Puts `top` on top of the blocks below its number. If it doesn't
         * build on them, a reorg replaced them too: the watch reads their
         * replacements by parent hash, down to a block it keeps. `top` is at
         * most one above the watch's top. Returns `false`, and changes
         * nothing, if a block left the chain meanwhile.
         */
        const reconcile = (top: LocalBlock) =>
          Effect.gen(function* () {
            const kept = chain.filter((block) => block.number < top.number);
            const removed = chain
              .filter((block) => block.number >= top.number)
              .reverse();
            /** The replacements below `top`, oldest first. */
            const parents: Header[] = [];
            let child: Header = top;
            while (child.parentHash !== (kept.at(-1) ?? root).hash) {
              const replaced = kept.pop();
              if (replaced === undefined) {
                return yield* new UnrecoverableReorgError({
                  number: top.number,
                  hash: top.hash,
                });
              }
              removed.push(replaced);
              const parent = yield* getHeader(child.parentHash);
              if (parent === undefined) return false;
              parents.unshift(parent);
              child = parent;
            }

            const added: LocalBlock[] = [];
            for (const block of yield* Effect.forEach(parents, withLogs, {
              concurrency: "unbounded",
            })) {
              if (block === undefined) return false;
              added.push(block);
            }
            added.push(top);

            chain = [...kept, ...added];
            while (chain.length > config.maxChainDepth) root = chain.shift()!;
            for (const block of removed) {
              yield* Queue.offer(queue, { _tag: "Removed", block });
            }
            for (const block of added) {
              yield* Queue.offer(queue, { _tag: "Added", block });
            }
            return true;
          });

        const poll = Effect.gen(function* () {
          const latest = yield* getHeader("latest");
          // A provider with no block past the root, or with a block the watch
          // has, is behind the watch.
          if (
            latest === undefined ||
            latest.number <= root.number ||
            chain.some((block) => block.hash === latest.hash)
          ) {
            return;
          }

          // A new top, or a replacement for blocks the watch has.
          if (latest.number <= tip().number + 1n) {
            const block = yield* withLogs(latest);
            if (block !== undefined) yield* reconcile(block);
            return;
          }

          // The watch is behind. It reads the blocks after its top by number,
          // so a reorg meanwhile shows in what it reads, and requests them in
          // parallel, so it keeps up when a block takes less time than a
          // request.
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
            for (const block of blocks) {
              if (block === undefined || !(yield* reconcile(block))) return;
            }
          }
        });

        yield* Effect.repeat(
          poll,
          Schedule.spaced(Duration.millis(config.pollIntervalMs)),
        );
      }),
    { bufferSize: config.bufferSize, strategy: "suspend" },
  );
}
