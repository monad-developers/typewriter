import type { Hex } from "ox";
import type {
  Address,
  Chain,
  Client,
  GetStorageAtParameters,
  Transport,
  UnionOmit,
} from "viem";
import { getStorageAt } from "viem/actions";
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

export type ReadStorageVariableParameters<
  layout extends StorageLayout = StorageLayout,
  variable = ConcreteStorageVariable<layout>,
> = {
  /** Address of the contract whose storage is read. */
  address: Address;
  /** Solidity compiler `storageLayout` output of the contract. */
  storageLayout: layout;
  /** Storage variable selector, for example `balances[0x…]`. */
  variable: variable;
} & UnionOmit<GetStorageAtParameters, "address" | "slot">;

/**
 * Read and decode one concrete storage variable with viem's `getStorageAt`,
 * one request per slot. Use `readStorageVariables` to read many variables in
 * one request.
 *
 * A long `bytes`/`string` value takes one request for its root slot, then one
 * per data slot. All requests are assumed to see the same state; pass
 * `blockNumber` or `blockHash` to make that true.
 *
 * @param client - viem client.
 * @param parameters - {@link ReadStorageVariableParameters}
 * @returns The decoded value, typed from the layout.
 * @throws Before any request, if `variable` does not select one supported
 * concrete value.
 *
 * @example
 * ```ts
 * const balance = await readStorageVariable(client, {
 *   address,
 *   storageLayout,
 *   variable: `balances[${account}]`,
 * }); // bigint
 * ```
 */
export async function readStorageVariable<
  chain extends Chain | undefined,
  const layout extends StorageLayout,
  variable extends ConcreteStorageVariable<layout>,
>(
  client: Client<Transport, chain>,
  parameters: ReadStorageVariableParameters<layout, variable>,
): Promise<NoInfer<StorageVariableToPrimitiveType<layout, variable>>> {
  const { address, storageLayout, variable, ...block } = parameters;
  const path = parseStoragePath(variable as unknown as string);
  const selector = formatStoragePath(path);
  const { type, slot } = resolveStoragePath(storageLayout, path);
  assertConcreteType(type, selector);

  const getStorageAtAction = getAction(client, getStorageAt, "getStorageAt");
  const getStorage = (slots: readonly Hex.Hex[]) =>
    Promise.all(
      slots.map(
        async (slot): Promise<Hex.Hex> =>
          (await getStorageAtAction({
            ...block,
            address,
            slot,
          } as GetStorageAtParameters)) ?? "0x0",
      ),
    );

  const root = await fetchStorage(getStorage, [slot]);
  const { dataSlots } =
    type.encoding === "bytes"
      ? bytesLength(slot, createSlotReader(root)(slot), selector)
      : { dataSlots: [] };
  const storage =
    dataSlots.length === 0
      ? root
      : { ...root, ...(await fetchStorage(getStorage, dataSlots)) };
  return decodeStorageVariable(
    storageLayout as StorageLayout,
    selector,
    storage,
  ) as never;
}
