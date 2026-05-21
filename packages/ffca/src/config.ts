import type { Effect } from "effect";
import type { Abi, Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { AbiParameter, PrivateKeyAccount } from "viem";
import type { DatabaseClient, DatabaseOptions } from "./db";
import type { MutationEvent, ResolvedMutation, RuntimeBundle } from "./types";

export type FFCADatabase = DatabaseClient;
export type FFCADatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];
type PersistenceHookResult = Effect.Effect<void, unknown>;

// `tag` is the contract enum index for this mutation; encoded as the uint8
// in the bundle's `mutations[]` field. Hand-authored for now — see the
// "derive from the contract" idea in AGENTS.md.
//
// `table` is the app-owned table for this mutation type. FFCA uses it for
// migration and for persistence hook callbacks; apps define the table shape.
//
// `persistMutation` writes the accepted mutation row. Submitted mutations stay
// in memory and are not persisted. `persistState` writes app state rows changed
// by this mutation from the current runtime state. `persistLifecycle` handles
// post-acceptance transitions like included/safe/finalized.
//
// `resolve` must be pure: read-only over `state`, `signature`, and `bundle`, no
// side effects. The runtime calls it once per mutation immediately before revm
// execution, and treats its return value as canonical (it's encoded into
// calldata). A `resolve` that mutates state breaks failure isolation and replay
// determinism.

type FFCAMutationPersistence = {
  table: unknown;
  persistMutation?: (
    tx: FFCADatabaseTransaction,
    params: {
      mutation: ResolvedMutation;
      bundle: RuntimeBundle;
    },
  ) => PersistenceHookResult;
  persistState?: (
    tx: FFCADatabaseTransaction,
    params: {
      mutation: ResolvedMutation;
    },
  ) => PersistenceHookResult;
  persistLifecycle?: (
    tx: FFCADatabaseTransaction,
    params:
      | {
          lifecycle: "included";
          mutation: MutationEvent & { status: "included" };
        }
      | {
          lifecycle: "safe";
          mutation: MutationEvent & { status: "safe" };
        }
      | {
          lifecycle: "finalized";
          mutation: MutationEvent & { status: "finalized" };
        },
  ) => PersistenceHookResult;
};

export type FFCAMutationConfig =
  | (FFCAMutationPersistence & {
      tag: number;
      params: readonly AbiParameter[];
    })
  | (FFCAMutationPersistence & {
      tag: number;
      params: readonly AbiParameter[];
      resolution: readonly AbiParameter[];
      resolve: (params: {
        state: unknown;
        args: unknown;
        signature: unknown;
      }) => unknown | Promise<unknown>;
    });

export type FFCAConfig = {
  address: Address.Address;
  domain: { name: string; version: string };
  abi: Abi.Abi;
  storageLayout: StorageLayout;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  database: DatabaseOptions;
  // `schema` is the user's Drizzle schema module for the persisted
  // representation; `load` hydrates runtime state from those tables on startup.
  // Apps define their table shapes and foreign keys; FFCA qualifies/migrates
  // them per deployment when persistence is enabled.
  //
  // `schema` is optional. Without user-owned persistence hooks, ffca runs
  // in-memory only. Fine for tests and short-lived demos; not enough for any
  // deployment that has to survive a process restart.
  state?: {
    schema?: Record<string, unknown>;
    load?: (tx: FFCADatabaseTransaction) => Effect.Effect<unknown, unknown>;
  };
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
