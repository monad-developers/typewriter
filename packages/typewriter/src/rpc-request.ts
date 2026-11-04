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
import { PendingTransactionsError } from "./typewriter-errors";

export type BlockIdentifier = number | bigint | Hash | "latest" | "finalized";
export type RequestedBlock<includeTransactions extends boolean = false> = Block<
  bigint,
  includeTransactions,
  Exclude<BlockTag, "pending">
>;

/** The call returned `0x`, for example because no contract is at `address`. */
export class NoDataReturnedError extends Data.TaggedError(
  "NoDataReturnedError",
)<{
  address: Address.Address;
  functionName: string;
}> {
  override get message() {
    return `Failed '${this.functionName}' call to ${this.address}: no data returned. Is a contract deployed at the address?`;
  }
}

export function requestBlock<includeTransactions extends boolean = false>(
  block: BlockIdentifier,
  includeTransactions: includeTransactions = false as includeTransactions,
): Effect.Effect<RequestedBlock<includeTransactions>, RpcError, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;

    const id = typeof block === "number" ? BigInt(block) : block;
    const rpcBlock =
      typeof id === "string" && id !== "latest" && id !== "finalized"
        ? yield* rpc.request({
            method: "eth_getBlockByHash",
            params: [id, includeTransactions],
          })
        : yield* rpc.request({
            method: "eth_getBlockByNumber",
            params: [
              typeof id === "string" ? id : Hex.fromNumber(id),
              includeTransactions,
            ],
          });

    // `Rpc` fails a `null` block with `BlockNotFoundError`.
    return formatBlock(
      rpcBlock!,
      "requestBlock",
    ) as RequestedBlock<includeTransactions>;
  });
}

function requestTypewriterView(
  address: Address.Address,
  blockHash: Hash,
  functionName: "executionIndex" | "executionHash",
): Effect.Effect<Hex.Hex, RpcError | NoDataReturnedError, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const result = yield* rpc.request({
      method: "eth_call",
      params: [
        {
          to: address,
          data: encodeFunctionData({
            abi: TYPEWRITER_ABI,
            functionName,
          }),
        },
        { blockHash },
      ],
    });

    if (result === "0x") {
      // TODO(kyle) retry `NoDataReturnedError` in `Rpc` service.
      return yield* new NoDataReturnedError({
        address,
        functionName,
      });
    }

    return result;
  });
}

export function requestExecutionIndex(
  address: Address.Address,
  blockHash: Hash,
): Effect.Effect<bigint, RpcError | NoDataReturnedError, Rpc> {
  return requestTypewriterView(address, blockHash, "executionIndex").pipe(
    Effect.map(Hex.toBigInt),
  );
}

export function requestExecutionHash(
  address: Address.Address,
  blockHash: Hash,
): Effect.Effect<Hex.Hex, RpcError | NoDataReturnedError, Rpc> {
  return requestTypewriterView(address, blockHash, "executionHash");
}

/** The scheduler's next nonce. Fails if it has pending transactions, e.g. from a previous process. */
export function requestNonce(
  address: Address.Address,
): Effect.Effect<number, RpcError | PendingTransactionsError, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const count = (tag: "latest" | "pending") =>
      rpc
        .request({ method: "eth_getTransactionCount", params: [address, tag] })
        .pipe(Effect.map(Hex.toNumber));
    const latest = yield* count("latest");
    const pending = yield* count("pending");
    if (pending > latest) {
      return yield* new PendingTransactionsError({ address, latest, pending });
    }
    return latest;
  });
}
