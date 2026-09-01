import type { Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { Abi, AbiParameter, PrivateKeyAccount } from "viem";
import type { TypewriterManifest } from "./config";
import type { DatabaseOptions } from "./db";
import type { TypewriterSchema } from "./schema";

export type InternalMutation = {
  id: number;
  params: readonly AbiParameter[];
};

type InternalConfirmations = {
  safeBlockDepth: number;
  finalizedBlockDepth: number;
};

type InternalFIFOSequencing = {
  order: "fifo";
  submitIntervalMs: number;
};

type InternalBatchSequencing = {
  order: "batch";
  batchIntervalMs: number;
  submitIntervalMs: number;
  batchOrder: string[];
};

type InternalSequencing = InternalFIFOSequencing | InternalBatchSequencing;

export type InternalApp = {
  address: Address.Address;
  abi: Abi;
  manifest: TypewriterManifest;
  storageLayout: StorageLayout;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrls: string[];
  database: DatabaseOptions;
  mutations: { [name: string]: InternalMutation };
  schema: TypewriterSchema;
  blockPollingIntervalMs: number;
  confirmations: InternalConfirmations;
  onFatalError: ((error: unknown) => void) | undefined;
  sequencing: InternalSequencing;
};
