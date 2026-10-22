import { Data, Effect } from "effect";
import { type Address, Hex } from "ox";
import {
  type Block,
  type BlockTag,
  encodeFunctionData,
  formatBlock,
  type Hash,
} from "viem";
import { Rpc, type RpcError } from "./rpc";
import { TYPEWRITER_ABI } from "./typewriter-constants";

export type BlockIdentifier = number | bigint | Hash;
export type RequestedBlock<includeTransactions extends boolean = false> = Block<
  bigint,
  includeTransactions,
  Exclude<BlockTag, "pending">
>;

/** The provider returned `null` for the block. */
export class BlockNotFoundError extends Data.TaggedError("BlockNotFoundError")<{
  block: Hash | bigint;
}> {}

/** The call returned `0x`, for example because no contract is at `address`. */
export class NoDataReturnedError extends Data.TaggedError(
  "NoDataReturnedError",
)<{
  address: Address.Address;
  functionName: string;
}> {}

export function requestBlock<includeTransactions extends boolean = false>(
  block: BlockIdentifier,
  includeTransactions: includeTransactions = false as includeTransactions,
): Effect.Effect<
  RequestedBlock<includeTransactions>,
  RpcError | BlockNotFoundError,
  Rpc
> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;

    const id = typeof block === "string" ? block : BigInt(block);
    const rpcBlock =
      typeof id === "string"
        ? yield* rpc.request({
            method: "eth_getBlockByHash",
            params: [id, includeTransactions],
          })
        : yield* rpc.request({
            method: "eth_getBlockByNumber",
            params: [Hex.fromNumber(id), includeTransactions],
          });

    if (rpcBlock === null) {
      // TODO(kyle) retry `BlockNotFoundError` in `Rpc` service.
      return yield* Effect.fail(new BlockNotFoundError({ block: id }));
    }
    return formatBlock(
      rpcBlock,
      "requestBlock",
    ) as RequestedBlock<includeTransactions>;
  });
}

export function requestExecutionIndex(
  address: Address.Address,
): Effect.Effect<bigint, RpcError | NoDataReturnedError, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const result = yield* rpc.request({
      method: "eth_call",
      params: [
        {
          to: address,
          data: encodeFunctionData({
            abi: TYPEWRITER_ABI,
            functionName: "executionIndex",
          }),
        },
        "latest",
      ],
    });

    if (result === "0x") {
      // TODO(kyle) retry `NoDataReturnedError` in `Rpc` service.
      return yield* Effect.fail(
        new NoDataReturnedError({ address, functionName: "executionIndex" }),
      );
    }

    return Hex.toBigInt(result);
  });
}
