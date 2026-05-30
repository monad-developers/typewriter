import type { PgTable } from "drizzle-orm/pg-core";
import type { Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { AbiParameter, PrivateKeyAccount } from "viem";
import type { DatabaseOptions } from "./db";

type InternalRegisterMappingKeys = (params: {
  args: unknown;
  signature: unknown;
  resolution?: unknown;
}) => readonly string[] | Promise<readonly string[]>;

type InternalMutationBase = {
  tag: number;
  params: readonly AbiParameter[];
  registerMappingKeys?: InternalRegisterMappingKeys;
};

type InternalMutation =
  | InternalMutationBase
  | (InternalMutationBase & {
      resolution: readonly AbiParameter[];
      resolve: (params: {
        state: unknown;
        args: unknown;
        signature: unknown;
      }) => unknown | Promise<unknown>;
    });

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
  domain: InternalDomain;
  signature: { params: readonly AbiParameter[] };
  storageLayout: StorageLayout;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrls: string[];
  database: DatabaseOptions;
  mutations: { [name: string]: InternalMutation };
  schema: Record<string, PgTable>;
  blockPollingIntervalMs: number;
  confirmations: InternalConfirmations;
  onFatalError: ((error: unknown) => void) | undefined;
  sequencing: InternalSequencing;
};
