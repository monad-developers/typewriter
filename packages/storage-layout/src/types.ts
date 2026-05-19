import type { Hex } from "ox";
import type {
  ExtractConcreteStoragePaths,
  ExtractStoragePaths,
  StorageLayout,
} from "./storage-layout";

export type SlotWrite = {
  value: Hex.Hex;
  mask: Hex.Hex;
};

export type SlotWrites = {
  [slot: Hex.Hex]: SlotWrite;
};

export type StoragePath<Layout extends StorageLayout> =
  ExtractStoragePaths<Layout>;

export type ConcreteStoragePath<Layout extends StorageLayout> =
  ExtractConcreteStoragePaths<Layout>;

/**
 * Key-value map of storage slots to their hex values.
 */
export type AccountStorage = {
  [slot: Hex.Hex]: Hex.Hex;
};
