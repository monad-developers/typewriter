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

export type RegisterMappingKeys = (params: {
  args: unknown;
  signature: unknown;
  resolution?: unknown;
}) => readonly string[] | Promise<readonly string[]>;

type FFCAMutationBase = {
  tag: number;
  params: readonly AbiParameter[];
  registerMappingKeys?: RegisterMappingKeys;
};

export type FFCAMutationConfig =
  | FFCAMutationBase
  | (FFCAMutationBase & {
      resolution: readonly AbiParameter[];
      resolve: (params: {
        state: unknown;
        args: unknown;
        signature: unknown;
      }) => unknown | Promise<unknown>;
    });

export type FFCASequencingConfig =
  | {
      order?: "fifo";
      submitIntervalMs?: number;
    }
  | {
      order?: "bundle";
      bundleIntervalMs?: number;
      submitIntervalMs?: number;
      bundleOrder: readonly string[];
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
  blockPollingIntervalMs?: number;
  confirmations?: {
    safeBlockDepth?: number;
    finalizedBlockDepth?: number;
  };
  // Runtime sequencing and loop cadence. FIFO is the default: mutations are
  // accepted one-at-a-time as soon as they enter the runtime, while submit still
  // flushes accepted mutations on an interval. `bundle` mode preserves the
  // delayed batch sort behavior used by existing apps/tests.
  // TODO(kyle) validate this with zod once the internal config shape settles.
  sequencing?: FFCASequencingConfig;
};

const DEFAULT_SAFE_BLOCK_DEPTH = 1;
const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;

function assertSafeNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
}

export function validateConfig(config: FFCAConfig): void {
  if (Array.isArray(config.rpcUrl) && config.rpcUrl.length === 0) {
    throw new Error("At least one RPC URL is required");
  }

  assertSafeNonNegativeInteger(
    config.blockPollingIntervalMs,
    "config.blockPollingIntervalMs",
  );

  const safeBlockDepth =
    config.confirmations?.safeBlockDepth ?? DEFAULT_SAFE_BLOCK_DEPTH;
  const finalizedBlockDepth =
    config.confirmations?.finalizedBlockDepth ?? DEFAULT_FINALIZED_BLOCK_DEPTH;

  assertSafeNonNegativeInteger(
    config.confirmations?.safeBlockDepth,
    "config.confirmations.safeBlockDepth",
  );
  assertSafeNonNegativeInteger(
    config.confirmations?.finalizedBlockDepth,
    "config.confirmations.finalizedBlockDepth",
  );

  if (finalizedBlockDepth < safeBlockDepth) {
    throw new Error(
      "config.confirmations.finalizedBlockDepth must be greater than or equal to config.confirmations.safeBlockDepth",
    );
  }

  const hasBundleOrder =
    config.sequencing !== undefined && "bundleOrder" in config.sequencing;

  if (config.sequencing?.order === "bundle" && hasBundleOrder === false) {
    throw new Error(
      "config.sequencing.bundleOrder is required for bundle ordering",
    );
  }

  if (config.sequencing?.order === "fifo" && hasBundleOrder) {
    throw new Error(
      "config.sequencing.bundleOrder is only valid for bundle ordering",
    );
  }

  const mutationTags = new Set<number>();
  for (const mutation of Object.values(config.mutations)) {
    if (mutationTags.has(mutation.tag)) {
      throw new Error(`duplicate mutation tag: ${mutation.tag}`);
    }
    mutationTags.add(mutation.tag);
  }
}
