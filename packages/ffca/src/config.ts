import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Abi, Address, Hex } from "ox";
import type { AbiParameter, PrivateKeyAccount } from "viem";
import type { ResolvedMutation } from "./types";

export type FFCADatabase = BunSQLDatabase<Record<string, PgTable>>;
export type FFCADatabaseTransaction = Parameters<
  Parameters<FFCADatabase["transaction"]>[0]
>[0];

// `tag` is the contract enum index for this mutation; encoded as the uint8
// in the bundle's `mutations[]` field. Hand-authored for now — see the
// "derive from the contract" idea in CLAUDE.md.
//
// `table` is the app-owned table for this mutation type. FFCA uses it for
// migration and for persistence hook callbacks; apps define the table shape.
//
// `persistMutation` writes the accepted mutation row. Pending mutations stay
// in memory and are not persisted. `persistState` writes app state rows changed
// by this mutation. `persistLifecycle` handles post-acceptance transitions like
// proposed/finalized/verified.
//
// `resolve` must be pure: read-only over `state`, `signature`, and `bundle`, no
// side effects. The runtime calls it once per mutation immediately before
// `apply`, and treats its return value as canonical (it's encoded into calldata
// and passed to `apply`). A `resolve` that mutates state breaks failure
// isolation and replay determinism.
//
// `bundle` is a read-only view of every mutation in this bundle (in
// post-sequence order, including this one). Use it for batch-aware decisions
// — e.g. seeing what other mutations are landing alongside this one.
export type BundleView = readonly { name: string; args: unknown }[];

type FFCAMutationPersistence = {
  table: PgTable;
  persistMutation?: (
    tx: FFCADatabaseTransaction,
    params: {
      mutation: Extract<ResolvedMutation, { status: "accepted" }>;
      bundle: { id: number; mutationIndex: number };
    },
  ) => Promise<void>;
  persistState?: (
    tx: FFCADatabaseTransaction,
    params: {
      mutation: Extract<ResolvedMutation, { status: "accepted" }>;
    },
  ) => Promise<void>;
  persistLifecycle?: (
    tx: FFCADatabaseTransaction,
    params:
      | {
          lifecycle: "proposed";
          mutation: Extract<ResolvedMutation, { status: "proposed" }>;
          block: {
            number: bigint;
            hash: Hex.Hex;
            timestamp: bigint;
            transactionHash: Hex.Hex;
          };
          calldata: Hex.Hex;
        }
      | {
          lifecycle: "voted";
          mutation: Extract<ResolvedMutation, { status: "voted" }>;
        }
      | {
          lifecycle: "finalized";
          mutation: Extract<ResolvedMutation, { status: "finalized" }>;
        }
      | {
          lifecycle: "verified";
          mutation: Extract<ResolvedMutation, { status: "verified" }>;
        },
  ) => Promise<void>;
};

export type FFCAMutationConfig =
  | (FFCAMutationPersistence & {
      tag: number;
      params: readonly AbiParameter[];
      apply: (state: unknown, args: unknown, signature: unknown) => void;
    })
  | (FFCAMutationPersistence & {
      tag: number;
      params: readonly AbiParameter[];
      resolution: readonly AbiParameter[];
      resolve: (
        state: unknown,
        args: unknown,
        signature: unknown,
        bundle: BundleView,
      ) => unknown;
      apply: (
        state: unknown,
        args: unknown,
        resolution: unknown,
        signature: unknown,
      ) => void;
    });

export type FFCAConfig = {
  address: Address.Address;
  domain: { name: string; version: string };
  abi: Abi.Abi;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  database?: { connection: Bun.SQL };
  // `initial` is the in-memory representation; `schema` is the user's Drizzle
  // schema module for the persisted representation. Apps define their table
  // shapes and foreign keys; FFCA qualifies/migrates them per deployment when
  // persistence is enabled.
  //
  // `schema` is optional. Without user-owned persistence hooks, ffca runs
  // in-memory only. Fine for tests and short-lived demos; not enough for any
  // deployment that has to survive a process restart.
  //
  // `initial` is hand-authored today. Once revm lands and the runtime can
  // read storage from the deployed contract, this becomes derivable — the
  // contract's post-deploy state is the canonical initial value.
  state: {
    initial: unknown;
    schema?: Record<string, PgTable>;
  };
  // ABI shape of one entry in the contract's `bundle.signatures[]` array.
  // Must include `keyType: uint8` and `rawSignature: bytes`; apps add
  // whatever else (account, keyId, …) the contract expects.
  signature: { params: readonly AbiParameter[] };
  mutations: { [name: string]: FFCAMutationConfig };
  // Order in which queued mutations are sorted within a bundle, before
  // resolve+apply. Every mutation submitted to the runtime must have a name
  // in this list. Stable within a name (insertion order preserved). Omit for
  // FIFO. Future: replace with a state-aware callback.
  sequence?: readonly string[];
};
