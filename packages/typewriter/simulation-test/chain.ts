import {
  Deferred,
  Effect,
  type Random,
  Schedule,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { Hex } from "ox";
import {
  makeHttpTransport,
  type RpcRequest,
  RpcResponseError,
  type RpcResult,
} from "../src/rpc-transport";
import { SIM } from "./index";

/** What a transaction changed: each account's values before and after. */
export type StateDiff = Record<
  "pre" | "post",
  Record<string, { storage?: Record<string, Hex.Hex> }>
>;

export type Chain = {
  request: <request extends RpcRequest>(
    request: request,
  ) => Effect.Effect<RpcResult<request["method"]>>;
  /**
   * What transaction `transactionHash` changed in block `blockHash`, traced
   * when the block was mined. A later trace replays the block on the state
   * before it, which Anvil drops after a few thousand blocks.
   */
  stateDiff: (
    blockHash: Hex.Hex,
    transactionHash: Hex.Hex,
  ) => StateDiff | undefined;
  /**
   * Answers `request` as a node that saw the chain as it was at `asOfMs`, in
   * virtual time. `undefined` is a block that node does not have, or whose
   * state Anvil dropped in a reorg.
   */
  read: <request extends RpcRequest>(
    request: request,
    asOfMs: number,
  ) => Effect.Effect<RpcResult<request["method"]> | undefined>;
  /** Mines one block at `atMs`, in virtual time. */
  mine: (atMs: number) => Effect.Effect<void>;
  /**
   * Replaces the last `depth` blocks with `added` new ones at `atMs`, in
   * virtual time. Block 1, where the contract is deployed, stays. Returns the
   * hashes of the blocks it replaced, and of the transactions it dropped.
   */
  reorg: (
    depth: number,
    added: number,
    atMs: number,
  ) => Effect.Effect<{ replaced: Hex.Hex[]; dropped: Hex.Hex[] }>;
};

type Block = {
  number: Hex.Hex;
  hash: Hex.Hex;
  parentHash: Hex.Hex;
  transactions: { hash: Hex.Hex; from: Hex.Hex }[];
};

type Receipt = {
  transactionHash: Hex.Hex;
  blockHash: Hex.Hex;
  logs: { address: Hex.Hex; topics: Hex.Hex[] }[];
};

type LogFilter = {
  blockHash?: Hex.Hex;
  address?: Hex.Hex | Hex.Hex[];
  topics?: (Hex.Hex | Hex.Hex[] | null)[];
};

/** The index of the block parameter of each method that reads state. */
const STATE_BLOCK_PARAM: Record<string, number | undefined> = {
  eth_call: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getStorageAt: 2,
  eth_getTransactionCount: 1,
};

/**
 * The third Anvil account. It sends one transaction in the first block of each
 * reorg, with the reorg's count as data, so the new blocks never hash the same
 * as the ones they replace.
 */
const REORG = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

export function makeChain(
  random: Random.Random,
): Effect.Effect<
  Chain,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    // The scope kills Anvil when it closes.
    const anvil = yield* ChildProcess.make(
      "anvil",
      [
        "--network",
        "monad",
        "--port",
        "0",
        "--no-mining",
        "--timestamp",
        String(SIM.chain.genesisTimestamp),
        // TODO(kyle) remove once typewriter caps a settlement's gas. It
        // settles a whole backlog in one transaction, which can go over the
        // 30M block gas limit and fail with "intrinsic gas too high".
        "--gas-limit",
        "1000000000",
      ],
      { stderr: "inherit" },
    ).pipe(Effect.orDie);

    // Read stdout until Anvil exits, so that Anvil does not block on a full pipe.
    const listening = yield* Deferred.make<number>();
    yield* anvil.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const match = /Listening on [\d.]+:(\d+)/.exec(line);
        return match === null
          ? Effect.void
          : Deferred.succeed(listening, Number(match[1]));
      }),
      Effect.andThen(
        Deferred.die(listening, new Error("anvil exited before it listened")),
      ),
      Effect.orDie,
      Effect.forkScoped,
    );
    const port = yield* Deferred.await(listening);

    const transport = makeHttpTransport(`http://127.0.0.1:${port}`);
    const lock = yield* Semaphore.make(1);

    const send = (request: RpcRequest) =>
      transport.request(request).pipe(
        Effect.retry({
          schedule: Schedule.exponential("10 millis"),
          times: 5,
          while: (error) => !(error instanceof RpcResponseError),
        }),
        Effect.orDie,
      );

    const request = ((request: RpcRequest) =>
      lock.withPermits(1)(send(request))) as Chain["request"];

    const getBlock = (number: Hex.Hex | "latest", full: boolean) =>
      send({
        method: "eth_getBlockByNumber",
        params: [number, full],
      }) as unknown as Effect.Effect<Block>;

    /** Every block Anvil mined, by hash. */
    const blocks = new Map<Hex.Hex, { number: number; parentHash: Hex.Hex }>();
    /** The canonical chain's hashes, by number. */
    const canonical: Hex.Hex[] = [];
    /** The canonical head after each change, in virtual time, with the highest head so far. */
    const heads: { atMs: number; hash: Hex.Hex; highest: number }[] = [];
    /** The blocks that reorgs replaced, with their receipts, by hash. */
    const orphans = new Map<Hex.Hex, { block: Block; receipts: Receipt[] }>();
    /** The replaced blocks that each transaction was in, by its hash. */
    const orphanedIn = new Map<Hex.Hex, Hex.Hex[]>();

    /** The highest head so far, which a reorg that shortens the chain lowers. */
    let highest = 0;

    const record = (block: Block) => {
      const number = Number(block.number);
      blocks.set(block.hash, { number, parentHash: block.parentHash });
      canonical.length = number;
      canonical.push(block.hash);
      highest = Math.max(highest, number);
    };

    const genesis = yield* getBlock("0x0", false);
    record(genesis);
    heads.push({ atMs: Number.NEGATIVE_INFINITY, hash: genesis.hash, highest });

    /** The canonical head at `asOfMs`. */
    const headAt = (asOfMs: number) => {
      let low = 0;
      let high = heads.length;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (heads[mid]!.atMs <= asOfMs) low = mid;
        else high = mid;
      }
      return heads[low]!;
    };

    /** The hash of block `number` on the chain that ends at `head`. */
    const hashAt = (head: Hex.Hex, number: number) => {
      let hash = head;
      while (true) {
        const block = blocks.get(hash)!;
        if (number > block.number) return undefined;
        if (canonical[block.number] === hash) return canonical[number];
        if (number === block.number) return hash;
        hash = block.parentHash;
      }
    };

    const read = ((request: RpcRequest, asOfMs: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const { hash: head, highest: highestSeen } = headAt(asOfMs);
          const seen = (hash: Hex.Hex) => {
            const block = blocks.get(hash);
            return block !== undefined && hashAt(head, block.number) === hash;
          };
          const blockByHash = (hash: Hex.Hex, full: boolean) => {
            const orphan = orphans.get(hash);
            if (orphan === undefined) {
              return send({
                method: "eth_getBlockByHash",
                params: [hash, full],
              });
            }
            return Effect.succeed(
              full
                ? orphan.block
                : {
                    ...orphan.block,
                    transactions: orphan.block.transactions.map(
                      ({ hash }) => hash,
                    ),
                  },
            );
          };
          const params = (request.params ?? []) as unknown[];

          switch (request.method) {
            case "eth_blockNumber":
              return Hex.fromNumber(blocks.get(head)!.number);
            case "eth_getBlockByNumber": {
              const [tag, full] = params as [string, boolean];
              if (tag === "finalized") {
                const number = Math.max(
                  0,
                  highestSeen - SIM.chain.finalizedBlockDepth,
                );
                return yield* blockByHash(hashAt(head, number)!, full);
              }
              if (tag !== "latest" && !tag.startsWith("0x")) {
                return yield* send(request);
              }
              const hash = tag === "latest" ? head : hashAt(head, Number(tag));
              return hash === undefined ? null : yield* blockByHash(hash, full);
            }
            case "eth_getBlockByHash": {
              const [hash, full] = params as [Hex.Hex, boolean];
              return seen(hash) ? yield* blockByHash(hash, full) : null;
            }
            case "eth_getLogs": {
              const [filter] = params as [LogFilter];
              if (filter.blockHash === undefined) return yield* send(request);
              if (!seen(filter.blockHash)) return undefined;
              const orphan = orphans.get(filter.blockHash);
              if (orphan === undefined) return yield* send(request);
              return orphan.receipts
                .flatMap(({ logs }) => logs)
                .filter((log) => matches(filter, log));
            }
            case "eth_getTransactionReceipt": {
              const [hash] = params as [Hex.Hex];
              const receipt = (yield* send(request)) as Receipt | null;
              if (receipt !== null && seen(receipt.blockHash)) return receipt;
              const blockHash = orphanedIn.get(hash)?.find(seen);
              if (blockHash === undefined) return null;
              return orphans
                .get(blockHash)!
                .receipts.find(
                  ({ transactionHash }) => transactionHash === hash,
                );
            }
          }

          const index = STATE_BLOCK_PARAM[request.method];
          if (index === undefined || params[index] === "pending") {
            return yield* send(request);
          }
          const block = (params[index] ?? "latest") as
            | string
            | { blockHash: Hex.Hex }
            | { blockNumber: Hex.Hex };
          const hash =
            block === "latest"
              ? head
              : typeof block === "string"
                ? hashAt(head, Number(block))
                : "blockHash" in block
                  ? seen(block.blockHash)
                    ? block.blockHash
                    : undefined
                  : hashAt(head, Number(block.blockNumber));
          // Anvil keeps no state for a block that a reorg replaced.
          if (hash === undefined || orphans.has(hash)) return undefined;
          const at = [...params];
          at[index] = { blockHash: hash };
          return yield* send({ ...request, params: at } as RpcRequest);
        }),
      )) as Chain["read"];

    /** By block hash, then transaction hash, lowercase. */
    const stateDiffs = new Map<string, StateDiff>();
    const stateDiffKey = (blockHash: Hex.Hex, transactionHash: Hex.Hex) =>
      `${blockHash}:${transactionHash}`.toLowerCase();

    // Mines one block and traces its transactions, while Anvil still has the
    // state before it.
    const mineBlock = (atMs: number) =>
      Effect.gen(function* () {
        // `PublicRpcSchema` does not include Anvil methods. Anvil takes whole
        // seconds, so blocks in the same second share a timestamp.
        yield* send({
          method: "evm_mine",
          params: [{ timestamp: Math.floor(atMs / 1000), blocks: 1 }],
        } as unknown as RpcRequest);
        const block = yield* getBlock("latest", false);
        record(block);
        for (const hash of block.transactions as unknown as Hex.Hex[]) {
          // `PublicRpcSchema` does not include `debug_traceTransaction`.
          const diff = (yield* send({
            method: "debug_traceTransaction",
            params: [
              hash,
              { tracer: "prestateTracer", tracerConfig: { diffMode: true } },
            ],
          } as unknown as RpcRequest)) as unknown as StateDiff;
          stateDiffs.set(stateDiffKey(block.hash, hash), diff);
        }
        return block.hash;
      });

    const stateDiff = (blockHash: Hex.Hex, transactionHash: Hex.Hex) =>
      stateDiffs.get(stateDiffKey(blockHash, transactionHash));

    const mine = (atMs: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const hash = yield* mineBlock(atMs);
          heads.push({ atMs, hash, highest });
        }),
      );

    let reorgs = 0;

    // A node puts the transactions of replaced blocks back in its pool, unless
    // it drops them. Anvil drops them, so they are sent again. Once a sender's
    // transaction is dropped, so are its later ones, whose nonces follow it.
    // Each one it keeps lands in a new block, or stays in the pool for the
    // block after them, in a shuffled order. Anvil holds a transaction whose
    // nonce is ahead until the one before it arrives.
    const reorg = (depth: number, added: number, atMs: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const head = canonical.length - 1;
          // The chain finalized every block `finalizedBlockDepth` below the
          // highest head, even if a reorg has since shortened the chain.
          const replaced = Math.min(
            depth,
            head - 1,
            head - highest + SIM.chain.finalizedBlockDepth,
          );
          if (replaced <= 0) return { replaced: [], dropped: [] };

          const hashes: Hex.Hex[] = [];
          const orphaned: { hash: Hex.Hex; from: string; raw: Hex.Hex }[] = [];
          for (let number = head - replaced + 1; number <= head; number++) {
            const block = yield* getBlock(Hex.fromNumber(number), true);
            const receipts = (yield* send({
              method: "eth_getBlockReceipts",
              params: [block.number],
            } as unknown as RpcRequest)) as unknown as Receipt[];
            orphans.set(block.hash, { block, receipts });
            hashes.push(block.hash);
            for (const { hash, from } of block.transactions) {
              orphanedIn.set(hash, [
                ...(orphanedIn.get(hash) ?? []),
                block.hash,
              ]);
              const raw = (yield* send({
                method: "eth_getRawTransactionByHash",
                params: [hash],
              } as unknown as RpcRequest)) as Hex.Hex;
              orphaned.push({ hash, from: from.toLowerCase(), raw });
            }
          }

          yield* send({
            method: "anvil_rollback",
            params: [replaced],
          } as unknown as RpcRequest);
          const dropped: Hex.Hex[] = [];
          const droppedFrom = new Set<string>();
          const slots = Array.from({ length: added + 1 }, (): Hex.Hex[] => []);
          for (const { hash, from, raw } of orphaned) {
            // A new marker takes the nonce of the first replaced one.
            if (from === REORG.toLowerCase()) continue;
            if (
              droppedFrom.has(from) ||
              random.nextDoubleUnsafe() < SIM.chain.dropRate
            ) {
              droppedFrom.add(from);
              dropped.push(hash);
              continue;
            }
            slots[Math.floor(random.nextDoubleUnsafe() * slots.length)]!.push(
              raw,
            );
          }
          const sendAll = (raws: Hex.Hex[]) =>
            Effect.forEach(
              shuffle(random, raws),
              (raw) =>
                send({ method: "eth_sendRawTransaction", params: [raw] }),
              { discard: true },
            );
          yield* send({
            method: "eth_sendTransaction",
            params: [
              {
                from: REORG,
                to: REORG,
                data: Hex.fromNumber(++reorgs, { size: 32 }),
              },
            ],
          });
          let hash = genesis.hash;
          for (let i = 0; i < added; i++) {
            yield* sendAll(slots[i]!);
            hash = yield* mineBlock(atMs);
          }
          yield* sendAll(slots[added]!);
          heads.push({ atMs, hash, highest });
          return { replaced: hashes, dropped };
        }),
      );

    return { request, read, stateDiff, mine, reorg };
  });
}

function shuffle<value>(random: Random.Random, values: value[]): value[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random.nextDoubleUnsafe() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
}

function matches(
  { address, topics = [] }: LogFilter,
  log: { address: Hex.Hex; topics: Hex.Hex[] },
) {
  const has = (wanted: Hex.Hex | Hex.Hex[], value: Hex.Hex | undefined) =>
    [wanted].flat().some((w) => w.toLowerCase() === value?.toLowerCase());
  return (
    (address === undefined || has(address, log.address)) &&
    topics.every((topic, i) => topic === null || has(topic, log.topics[i]))
  );
}
