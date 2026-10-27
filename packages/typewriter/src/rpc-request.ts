import { Data, Effect } from "effect";
import { type Address, Hex } from "ox";
import type { AccountStorage } from "storage-layout";
import {
  type Block,
  type BlockTag,
  encodeFunctionData,
  formatBlock,
  type Hash,
  keccak256,
} from "viem";
import { Rpc, type RpcError } from "./rpc";
import { TYPEWRITER_ABI } from "./typewriter-constants";

export type BlockIdentifier = number | bigint | Hash | "latest";
export type RequestedBlock<includeTransactions extends boolean = false> = Block<
  bigint,
  includeTransactions,
  Exclude<BlockTag, "pending">
>;

/** The provider returned `null` for the block. */
export class BlockNotFoundError extends Data.TaggedError("BlockNotFoundError")<{
  block: Hash | bigint | "latest";
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

    const id = typeof block === "number" ? BigInt(block) : block;
    const rpcBlock =
      typeof id === "string" && id !== "latest"
        ? yield* rpc.request({
            method: "eth_getBlockByHash",
            params: [id, includeTransactions],
          })
        : yield* rpc.request({
            method: "eth_getBlockByNumber",
            params: [
              id === "latest" ? id : Hex.fromNumber(id),
              includeTransactions,
            ],
          });

    if (rpcBlock === null) {
      // TODO(kyle) retry `BlockNotFoundError` in `Rpc` service.
      return yield* new BlockNotFoundError({ block: id });
    }
    return formatBlock(
      rpcBlock,
      "requestBlock",
    ) as RequestedBlock<includeTransactions>;
  });
}

const slotHex = (slot: bigint): Hex.Hex =>
  Hex.fromNumber(slot % 2n ** 256n, { size: 32 });

const range = (length: bigint) =>
  Array.from({ length: Number(length) }, (_, i) => BigInt(i));

/**
 * The storage of the force-inclusion queue of the Typewriter at `address`, at
 * `blockHash`: the queue's length, and the slots of each entry that has not
 * executed. An entry that executed is zero.
 */
export function requestQueueStorage(
  address: Address.Address,
  queueSlot: bigint,
  blockHash: Hash,
): Effect.Effect<AccountStorage, RpcError, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const storage: AccountStorage = {};
    const read = (slot: bigint) =>
      rpc
        .request({
          method: "eth_getStorageAt",
          params: [address, slotHex(slot), { blockHash }],
        })
        .pipe(
          Effect.map((value) => {
            storage[slotHex(slot)] = value;
            return Hex.toBigInt(value);
          }),
        );

    const length = yield* read(queueSlot);
    const base = Hex.toBigInt(keccak256(slotHex(queueSlot)));
    // `QueuedMutation` takes 4 slots: `mutation`, `mutationData`,
    // `authorizationData`, and `enqueuedBlock`.
    yield* Effect.forEach(
      range(length),
      (index) =>
        Effect.gen(function* () {
          const entry = base + 4n * index;
          if ((yield* read(entry + 3n)) === 0n) return;
          yield* read(entry);
          for (const slot of [entry + 1n, entry + 2n]) {
            // `bytes` of 32 or more stores 2 * length + 1, and its data from
            // keccak256(slot). Shorter `bytes` is in the slot.
            const value = yield* read(slot);
            if (value % 2n === 0n) continue;
            const data = Hex.toBigInt(keccak256(slotHex(slot)));
            const words = ((value - 1n) / 2n + 31n) / 32n;
            yield* Effect.forEach(range(words), (word) => read(data + word));
          }
        }),
      { concurrency: 16 },
    );
    return storage;
  });
}

export function requestExecutionIndex(
  address: Address.Address,
  blockHash: Hash,
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
        { blockHash },
      ],
    });

    if (result === "0x") {
      // TODO(kyle) retry `NoDataReturnedError` in `Rpc` service.
      return yield* new NoDataReturnedError({
        address,
        functionName: "executionIndex",
      });
    }

    return Hex.toBigInt(result);
  });
}
