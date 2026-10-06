import type { Hex } from "ox";
import type {
  Address,
  Chain,
  Client,
  GetStorageValuesParameters,
  Transport,
  UnionOmit,
} from "viem";
import { getStorageValues } from "viem/actions";
import { getAction } from "viem/utils";
import { createSlotReader, fetchStorage } from "./account-storage";
import {
  assertConcreteType,
  bytesLength,
  decodeStorageVariable,
} from "./decodeStorageVariable";
import { resolveStoragePath, type StorageLayout } from "./storage-layout";
import { formatStoragePath, parseStoragePath } from "./storage-path";
import type {
  ConcreteStorageVariable,
  StorageVariableToPrimitiveType,
} from "./types";

export type ReadStorageVariablesParameters<
  layout extends StorageLayout = StorageLayout,
  variables = readonly ConcreteStorageVariable<layout>[],
> = {
  /** Address of the contract whose storage is read. */
  address: Address;
  /** Solidity compiler `storageLayout` output of the contract. */
  storageLayout: layout;
  /** Storage variable selectors, for example `["totalSupply", "owner"]`. */
  variables: variables;
} & UnionOmit<GetStorageValuesParameters, "requests">;

/** Decoded values of `variables`, in the same order. */
export type ReadStorageVariablesReturnType<
  layout extends StorageLayout,
  variables extends readonly unknown[],
> = {
  -readonly [index in keyof variables]: StorageVariableToPrimitiveType<
    layout,
    variables[index]
  >;
};

/**
 * Read and decode many concrete storage variables of one contract with viem's
 * `getStorageValues`. The RPC node must support `eth_getStorageValues`.
 *
 * One request reads every slot once, so packed variables share a read. Long
 * `bytes`/`string` values take a second request for their data slots. Pass
 * `blockNumber` or `blockHash` so that both requests see the same state.
 *
 * @param client - viem client.
 * @param parameters - {@link ReadStorageVariablesParameters}
 * @returns The decoded values, in the order of `variables`.
 * @throws Before any request, if a variable does not select one supported
 * concrete value.
 *
 * @example
 * ```ts
 * const [totalSupply, owner] = await readStorageVariables(client, {
 *   address,
 *   storageLayout,
 *   variables: ["totalSupply", "owner"],
 * }); // [bigint, `0x${string}`]
 * ```
 */
export async function readStorageVariables<
  chain extends Chain | undefined,
  const layout extends StorageLayout,
  const variables extends readonly ConcreteStorageVariable<layout>[],
>(
  client: Client<Transport, chain>,
  parameters: ReadStorageVariablesParameters<layout, variables>,
): Promise<NoInfer<ReadStorageVariablesReturnType<layout, variables>>> {
  const { address, storageLayout, variables, ...block } = parameters;
  const selectors = variables as unknown as readonly string[];
  const leaves = selectors.map((variable) => {
    const path = parseStoragePath(variable);
    const { type, slot } = resolveStoragePath(storageLayout, path);
    const selector = formatStoragePath(path);
    assertConcreteType(type, selector);
    return { selector, slot, isBytes: type.encoding === "bytes" };
  });
  if (leaves.length === 0) return [] as never;

  const getStorageValuesAction = getAction(
    client,
    getStorageValues,
    "getStorageValues",
  );
  const getStorage = async (slots: readonly Hex.Hex[]) => {
    const result = await getStorageValuesAction({
      ...block,
      requests: { [address]: slots },
    } as GetStorageValuesParameters);
    // Nodes may change the case of the address key.
    const entry = Object.entries(result).find(
      ([key]) => key.toLowerCase() === address.toLowerCase(),
    );
    if (entry === undefined) {
      throw new Error(`getStorageValues returned no values for ${address}`);
    }
    return entry[1];
  };

  const roots = await fetchStorage(
    getStorage,
    leaves.map((leaf) => leaf.slot),
  );
  const readRoot = createSlotReader(roots);
  const dataSlots = leaves
    .filter((leaf) => leaf.isBytes)
    .flatMap(
      (leaf) =>
        bytesLength(leaf.slot, readRoot(leaf.slot), leaf.selector).dataSlots,
    );
  const storage =
    dataSlots.length === 0
      ? roots
      : { ...roots, ...(await fetchStorage(getStorage, dataSlots)) };
  return selectors.map((variable) =>
    decodeStorageVariable(storageLayout as StorageLayout, variable, storage),
  ) as never;
}
