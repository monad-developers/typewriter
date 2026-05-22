import type { Hex } from "ox";
import type {
  ExtractConcreteStorageVariables,
  ExtractStorageVariables,
  StorageLayout,
} from "./storage-layout";

export type SlotWrite = {
  value: Hex.Hex;
  mask: Hex.Hex;
};

export type SlotWrites = {
  [slot: Hex.Hex]: SlotWrite;
};

export type StorageVariable<Layout extends StorageLayout> =
  ExtractStorageVariables<Layout>;

export type ConcreteStorageVariable<Layout extends StorageLayout> =
  ExtractConcreteStorageVariables<Layout> extends infer variable extends string
    ? variable
    : never;

/**
 * Key-value map of storage slots to their hex values.
 */
export type AccountStorage = {
  [slot: Hex.Hex]: Hex.Hex;
};
