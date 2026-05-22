import type { Abi, Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { AbiParameter, PrivateKeyAccount } from "viem";
import type { DatabaseClient, DatabaseOptions } from "./db";

export type FFCADatabase = DatabaseClient;
export type FFCADatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];

// `tag` is the contract enum index for this mutation; encoded as the uint8
// in the bundle's `mutations[]` field. Hand-authored for now — see the
// "derive from the contract" idea in AGENTS.md.
//
// `resolve` must be pure: read-only over `state`, `signature`, and `bundle`, no
// side effects. The runtime calls it once per mutation immediately before revm
// execution, and treats its return value as canonical (it's encoded into
// calldata). A `resolve` that mutates state breaks failure isolation and replay
// determinism.

export type FFCAMutationConfig =
  | {
      tag: number;
      params: readonly AbiParameter[];
    }
  | {
      tag: number;
      params: readonly AbiParameter[];
      resolution: readonly AbiParameter[];
      resolve: (params: {
        state: unknown;
        args: unknown;
        signature: unknown;
      }) => unknown | Promise<unknown>;
    };

export type FFCAConfig = {
  address: Address.Address;
  domain: { name: string; version: string };
  abi: Abi.Abi;
  storageLayout: StorageLayout;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  database: DatabaseOptions;
  mutations: { [name: string]: FFCAMutationConfig };
  confirmations?: {
    safeBlockDepth?: number;
    finalizedBlockDepth?: number;
  };
  // Runtime sequencing and loop cadence. FIFO is the default: mutations are
  // accepted one-at-a-time as soon as they enter the runtime, while submit still
  // flushes accepted mutations on an interval. `bundle` mode preserves the
  // delayed batch sort behavior used by existing apps/tests.
  sequencing?:
    | {
        order?: "fifo";
        submitIntervalMs?: number;
        blockPollingIntervalMs?: number;
      }
    | {
        order?: "bundle";
        bundleIntervalMs?: number;
        submitIntervalMs?: number;
        blockPollingIntervalMs?: number;
      };
  // Order in which queued mutations are sorted within a bundle, before
  // resolve+apply. Every mutation submitted to the runtime must have a name
  // in this list when sequencing.order is "bundle". Stable within a name
  // (insertion order preserved). Omit for FIFO. Future: replace with a
  // state-aware callback.
  sequence?: readonly string[];
};
