import type { Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { Abi, AbiParameter, PrivateKeyAccount } from "viem";
import type { DatabaseOptions } from "./db";
import type { FFCASchema } from "./schema";

export type InternalMutation = {
  tag: number;
  params: readonly AbiParameter[];
  registerMappingKeys?: (params: {
    params: unknown;
    signature: unknown;
  }) => readonly string[] | Promise<readonly string[]>;
};

type InternalConfirmations = {
  safeBlockDepth: number;
  finalizedBlockDepth: number;
};

type InternalDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address.Address;
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
  domain: InternalDomain;
  signature: { params: readonly AbiParameter[] };
  storageLayout: StorageLayout;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrls: string[];
  database: DatabaseOptions;
  mutations: { [name: string]: InternalMutation };
  schema: FFCASchema;
  blockPollingIntervalMs: number;
  confirmations: InternalConfirmations;
  onFatalError: ((error: unknown) => void) | undefined;
  sequencing: InternalSequencing;
};
