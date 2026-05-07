import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Abi, Address, Hex } from "ox";
import type { AbiParameter, PrivateKeyAccount } from "viem";

export type FFCADatabase = BunSQLDatabase<Record<string, PgTable>>;
export type FFCADatabaseTransaction = Parameters<
  Parameters<FFCADatabase["transaction"]>[0]
>[0];

export type FFCAPersistContext = {
  tx: FFCADatabaseTransaction;
  state: unknown;
  mutation: unknown;
  bundle?: unknown;
  block?: unknown;
  calldata?: Hex.Hex;
};

// `tag` is the contract enum index for this mutation; encoded as the uint8
// in the bundle's `mutations[]` field. Hand-authored for now — see the
// "derive from the contract" idea in CLAUDE.md.
//
// `table` is the app-owned table for this mutation type. FFCA does not join
// against it or migrate it; persistence hooks use it to know where this
// mutation's lifecycle/read-model rows belong.
//
// `persistMutation` writes the accepted mutation row. Pending mutations stay
// in memory and are not persisted. `persistState` writes app state rows changed
// by this mutation. `persistLifecycle` handles post-acceptance transitions like
// proposed/finalized/verified.
//
// `resolve` must be pure: read-only over `state` and `bundle`, no side
// effects. The runtime calls it once per mutation immediately before `apply`,
// and treats its return value as canonical (it's encoded into calldata and
// passed to `apply`). A `resolve` that mutates state breaks failure isolation
// and replay determinism.
//
// `bundle` is a read-only view of every mutation in this bundle (in
// post-sequence order, including this one). Use it for batch-aware decisions
// — e.g. seeing what other mutations are landing alongside this one.
export type BundleView = readonly { name: string; args: unknown }[];

type FFCAMutationPersistence = {
  table: PgTable;
  persistMutation?: (ctx: FFCAPersistContext) => Promise<void>;
  persistState?: (ctx: FFCAPersistContext) => Promise<void>;
  persistLifecycle?: (ctx: FFCAPersistContext) => Promise<void>;
};

export type FFCAMutationConfig =
  | (FFCAMutationPersistence & {
      tag: number;
      params: readonly AbiParameter[];
      apply: (state: unknown, args: unknown) => void;
    })
  | (FFCAMutationPersistence & {
      tag: number;
      params: readonly AbiParameter[];
      resolution: readonly AbiParameter[];
      resolve: (state: unknown, args: unknown, bundle: BundleView) => unknown;
      apply: (state: unknown, args: unknown, resolution: unknown) => void;
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
  // schema module for the persisted representation. FFCA does not own built-in
  // tables, migrations, joins, or foreign keys here — apps define their full
  // database shape and can use helpers from `ffca/schema` for shared columns.
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
