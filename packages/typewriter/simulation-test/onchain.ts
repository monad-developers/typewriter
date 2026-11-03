import { Effect } from "effect";
import { AbiFunction, Hex } from "ox";
import { decodeEventLog } from "viem";
import type { TypewriterApp } from "../src/config";
import { decodeAuthorizationCalldata } from "../src/encoding";
import { EXPIRATION_MARGIN, TYPEWRITER_ABI } from "../src/typewriter-constants";
import type { Inclusion } from "../src/typewriter-types";
import type { Chain } from "./chain";
import { mutationKey, type Submission } from "./run";

/** A mutation that executed onchain. */
export type Executed = {
  key: string;
  executionIndex: bigint;
  inclusion: Inclusion;
  /** Its batch, counted across settlements. Unset when force-executed. */
  batch: number | undefined;
  /** Its queue index when force-executed. */
  queueIndex: bigint | undefined;
};

/** A settlement transaction on the canonical chain. */
export type Settlement = Inclusion & {
  reverted: boolean;
  /** It reverted because an earlier settlement did, so the execution index moved. */
  mismatched: boolean;
  /** The execution indexes of its mutations, in execution order. */
  executionIndexes: bigint[];
  /** It landed before the block it pinned, or more than `EXPIRATION_MARGIN` seconds after it. */
  late: boolean;
};

/** What happened onchain, read from the canonical chain after the run. */
export type Onchain = {
  settlements: Settlement[];
  /** In execution order. */
  executed: Executed[];
  /** The keys of each batch, in execution order. */
  batches: string[][];
  /** The queue index of each `enqueue` transaction. */
  queueIndexes: Map<Hex.Hex, bigint>;
  /** The hash of each canonical block, by number. */
  blockHashes: Map<bigint, Hex.Hex>;
};

const EXECUTE = AbiFunction.fromAbi(TYPEWRITER_ABI, "execute");

type Transaction = {
  hash: Hex.Hex;
  from: Hex.Hex;
  to: Hex.Hex | null;
  input: Hex.Hex;
  transactionIndex: Hex.Hex;
};

/**
 * Reads every settlement and `enqueue` of the canonical chain. A batch entry
 * is keyed by its authorization, like the events.
 */
export function readOnchain({
  app,
  chain,
  submissions,
}: {
  app: TypewriterApp;
  chain: Chain;
  submissions: readonly Submission[];
}): Effect.Effect<Onchain> {
  return Effect.gen(function* () {
    const keyByEnqueue = new Map(
      submissions.map((submission) => [
        submission.transactionHash,
        submission.key,
      ]),
    );
    const scheduler = app.account.address.toLowerCase();
    const address = app.address.toLowerCase();

    const onchain: Onchain = {
      settlements: [],
      executed: [],
      batches: [],
      queueIndexes: new Map(),
      blockHashes: new Map(),
    };
    const keyByQueueIndex = new Map<bigint, string>();
    const authorizationDataByQueueIndex = new Map<bigint, Hex.Hex>();

    const head = Number(yield* chain.request({ method: "eth_blockNumber" }));
    for (let number = 0; number <= head; number++) {
      const block = (yield* chain.request({
        method: "eth_getBlockByNumber",
        params: [Hex.fromNumber(number), true],
      }))!;
      onchain.blockHashes.set(BigInt(number), block.hash!);

      for (const transaction of block.transactions as unknown as Transaction[]) {
        if (transaction.to?.toLowerCase() !== address) continue;
        const receipt = (yield* chain.request({
          method: "eth_getTransactionReceipt",
          params: [transaction.hash],
        }))!;

        if (transaction.from.toLowerCase() !== scheduler) {
          for (const log of receipt.logs) {
            const { args } = decodeEventLog({
              abi: TYPEWRITER_ABI,
              eventName: "ForceInclusionQueued",
              topics: log.topics as [Hex.Hex, ...Hex.Hex[]],
              data: log.data,
              strict: true,
            });
            onchain.queueIndexes.set(transaction.hash, args.index);
            authorizationDataByQueueIndex.set(
              args.index,
              args.authorizationData,
            );
            keyByQueueIndex.set(
              args.index,
              keyByEnqueue.get(transaction.hash) ??
                `unsubmitted enqueue ${args.index}`,
            );
          }
          continue;
        }

        const inclusion: Inclusion = {
          blockNumber: BigInt(number),
          blockHash: block.hash!,
          blockTimestamp: BigInt(block.timestamp),
          transactionHash: transaction.hash,
          transactionIndex: Number(transaction.transactionIndex),
        };
        const [
          fromExecutionIndex,
          pinnedNumber,
          pinnedTimestamp,
          batches,
          forceExecuteIndexes,
        ] = AbiFunction.decodeData(EXECUTE, transaction.input);
        const settlement: Settlement = {
          ...inclusion,
          reverted: receipt.status !== "0x1",
          mismatched: fromExecutionIndex !== BigInt(onchain.executed.length),
          executionIndexes: [],
          late:
            pinnedNumber > inclusion.blockNumber ||
            inclusion.blockTimestamp - pinnedTimestamp >
              BigInt(EXPIRATION_MARGIN),
        };
        onchain.settlements.push(settlement);
        if (settlement.reverted) {
          continue;
        }

        const execute = (
          executed: Pick<Executed, "key" | "batch" | "queueIndex">,
        ) => {
          const executionIndex = BigInt(onchain.executed.length);
          settlement.executionIndexes.push(executionIndex);
          onchain.executed.push({ ...executed, executionIndex, inclusion });
        };
        for (const batch of batches) {
          const keys = batch.authorizationData.map((authorizationData) => {
            const key = mutationKey(
              decodeAuthorizationCalldata(authorizationData),
            );
            execute({
              key,
              batch: onchain.batches.length,
              queueIndex: undefined,
            });
            return key;
          });
          onchain.batches.push(keys);
        }
        for (const queueIndex of forceExecuteIndexes) {
          execute({
            key:
              keyByQueueIndex.get(queueIndex) ??
              `unknown queue index ${queueIndex}`,
            batch: undefined,
            queueIndex,
          });
        }
      }
    }
    return onchain;
  });
}
