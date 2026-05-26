import { Effect } from "effect";
import {
  type Block,
  BlockNotFoundError,
  type BlockTag,
  formatBlock,
  type Hash,
} from "viem";
import { Rpc } from "./rpc";

export type BlockIdentifier = number | bigint | Hash;
export type RequestedBlock<includeTransactions extends boolean = false> = Block<
  bigint,
  includeTransactions,
  Exclude<BlockTag, "pending">
>;

export function requestBlock<includeTransactions extends boolean = false>(
  block: BlockIdentifier,
  includeTransactions: includeTransactions = false as includeTransactions,
): Effect.Effect<RequestedBlock<includeTransactions>, unknown, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;

    if (typeof block === "string") {
      const rpcBlock = yield* rpc.request({
        method: "eth_getBlockByHash",
        params: [block, includeTransactions],
      });
      if (rpcBlock === null) {
        return yield* Effect.fail(new BlockNotFoundError({ blockHash: block }));
      }
      return formatBlock(
        rpcBlock,
        "requestBlock",
      ) as RequestedBlock<includeTransactions>;
    }

    const blockNumber = BigInt(block);
    const rpcBlock = yield* rpc.request({
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, includeTransactions],
    });
    if (rpcBlock === null) {
      return yield* Effect.fail(new BlockNotFoundError({ blockNumber }));
    }
    return formatBlock(
      rpcBlock,
      "requestBlock",
    ) as RequestedBlock<includeTransactions>;
  });
}
