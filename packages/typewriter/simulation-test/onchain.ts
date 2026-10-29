import { Effect } from "effect";
import { AbiFunction, Hex } from "ox";
import { decodeEventLog } from "viem";
import type { TypewriterApp } from "../src/config";
import {
  decodeAuthorizationCalldata,
  encodeAuthorizationCalldata,
  encodeMutationCalldata,
} from "../src/encoding";
import { TYPEWRITER_ABI } from "../src/typewriter-constants";
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
  /** Its encoding in the settlement. Unset when force-executed. */
  encoding: string | undefined;
};

/** A settlement transaction on the canonical chain. */
export type Settlement = Inclusion & {
  reverted: boolean;
  /** The execution indexes of its mutations, in execution order. */
  executionIndexes: bigint[];
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
  /** The `authorizationData` of each `enqueue`, by queue index. */
  enqueuedAuthorizationData: Map<bigint, Hex.Hex>;
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
 * is keyed by its authorization, like the events, and keeps its encoding to
 * compare with what was submitted.
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
      enqueuedAuthorizationData: new Map(),
      blockHashes: new Map(),
    };
    const keyByQueueIndex = new Map<bigint, string>();

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
            onchain.enqueuedAuthorizationData.set(
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
        const settlement: Settlement = {
          ...inclusion,
          reverted: receipt.status !== "0x1",
          executionIndexes: [],
        };
        onchain.settlements.push(settlement);
        if (settlement.reverted) continue;

        const execute = (
          executed: Pick<Executed, "key" | "batch" | "queueIndex" | "encoding">,
        ) => {
          const executionIndex = BigInt(onchain.executed.length);
          settlement.executionIndexes.push(executionIndex);
          onchain.executed.push({ ...executed, executionIndex, inclusion });
        };
        const [batches, forceExecuteIndexes] = AbiFunction.decodeData(
          EXECUTE,
          transaction.input,
        );
        for (const batch of batches) {
          const keys = batch.mutations.map((id, i) => {
            const authorizationData = batch.authorizationData[i]!;
            const key = mutationKey(
              decodeAuthorizationCalldata(authorizationData),
            );
            execute({
              key,
              batch: onchain.batches.length,
              queueIndex: undefined,
              encoding: encode(id, batch.mutationData[i]!, authorizationData),
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
            encoding: undefined,
          });
        }
      }
    }
    return onchain;
  });
}

/** The encoding of the well-formed mutation of `submission` in a batch. */
export function encodingOf(app: TypewriterApp, submission: Submission): string {
  const { name, params, authorization } = submission.mutation;
  const config = app.mutations[name]!;
  return encode(
    config.id,
    encodeMutationCalldata({ config, params }),
    encodeAuthorizationCalldata(authorization),
  );
}

function encode(
  id: number,
  mutationData: Hex.Hex,
  authorizationData: Hex.Hex,
): string {
  return `${id}:${mutationData}:${authorizationData}`.toLowerCase();
}
