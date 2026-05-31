import type { AbiParametersToPrimitiveTypes } from "abitype";
import type { Address } from "ox";
import type {
  ConcreteStorageVariable,
  StorageLayout,
  StorageProxy,
} from "storage-layout";
import type { AbiParameter, PrivateKeyAccount } from "viem";
import type { DatabaseClient, DatabaseOptions } from "./db";
import type { InternalApp } from "./internal";
import { createMutationSchema } from "./schema";

export type FFCADatabase = DatabaseClient;
export type FFCADatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];

// `tag` is the contract enum index for this mutation; encoded as the uint8
// in the batch's `mutations[]` field. Hand-authored for now — see the
// "derive from the contract" idea in AGENTS.md.
//
// `resolve` must be pure: read-only over `state`, `signature`, and `batch`, no
// side effects. The runtime calls it once per mutation immediately before revm
// execution, and treats its return value as canonical (it's encoded into
// calldata). A `resolve` that mutates state breaks failure isolation and replay
// determinism.

export type StorageConfig = StorageLayout;
export type MutationConfig = {
  params: readonly AbiParameter[];
  resolution?: readonly AbiParameter[];
};
export type MutationsConfig = { [name: string]: MutationConfig };
export type SignatureConfig = readonly AbiParameter[];
export type SequencingConfig = "fifo" | "batch";

export type RegisterMappingKeys<
  storageConfig extends StorageConfig,
  mutationConfig extends MutationConfig,
  signatureConfig extends SignatureConfig,
  ///
  storageVariables = ConcreteStorageVariable<storageConfig>,
> = (
  params: mutationConfig extends { resolution: readonly AbiParameter[] }
    ? {
        params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
        signature: AbiParametersToPrimitiveTypes<signatureConfig>;
        resolution: AbiParametersToPrimitiveTypes<mutationConfig["resolution"]>;
      }
    : {
        params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
        signature: AbiParametersToPrimitiveTypes<signatureConfig>;
      },
) => readonly storageVariables[] | Promise<readonly storageVariables[]>;

export type FFCAMutationConfig<
  storageConfig extends StorageConfig = StorageConfig,
  mutationConfig extends MutationConfig = MutationConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = mutationConfig extends { resolution: readonly AbiParameter[] }
  ? {
      tag: number;
      params: mutationConfig["params"];
      resolution: mutationConfig["resolution"];
      resolve: (params: {
        state: StorageProxy<storageConfig, true>;
        params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
        signature: AbiParametersToPrimitiveTypes<signatureConfig>;
      }) =>
        | AbiParametersToPrimitiveTypes<mutationConfig["resolution"]>
        | Promise<AbiParametersToPrimitiveTypes<mutationConfig["resolution"]>>;
      registerMappingKeys?: RegisterMappingKeys<
        storageConfig,
        mutationConfig,
        signatureConfig
      >;
    }
  : {
      tag: number;
      params: mutationConfig["params"];
      registerMappingKeys?: RegisterMappingKeys<
        storageConfig,
        mutationConfig,
        signatureConfig
      >;
    };

export type FFCASequencingConfig<sequencingConfig extends SequencingConfig> =
  | {
      order: sequencingConfig extends "fifo" ? sequencingConfig : never;
      submitIntervalMs?: number;
    }
  | {
      order: sequencingConfig extends "batch" ? sequencingConfig : never;
      batchIntervalMs?: number;
      submitIntervalMs?: number;
      batchOrder: readonly string[];
    };

export type FFCAConfig<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  address: Address.Address;
  domain: { name: string; version: string };
  storageLayout: storageConfig;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  database: DatabaseOptions;
  mutations: mutationsConfig & {
    [name in keyof mutationsConfig]: FFCAMutationConfig<
      storageConfig,
      mutationsConfig[name],
      signatureConfig
    >;
  };
  signature: { params: signatureConfig };
  blockPollingIntervalMs?: number;
  confirmations?: {
    safeBlockDepth?: number;
    finalizedBlockDepth?: number;
  };
  onFatalError?: (error: unknown) => void;
  // Runtime sequencing and loop cadence. FIFO is the default: mutations are
  // accepted in arrival order through short internal batches, while submit still
  // flushes accepted mutations on an interval. `batch` mode uses the same
  // internals, but may reorder each batch by `batchOrder`.
  // TODO(kyle) validate this with zod once the internal config shape settles.
  sequencing?: FFCASequencingConfig<sequencingConfig>;
};

const DEFAULT_SAFE_BLOCK_DEPTH = 1;
const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;
const DEFAULT_BLOCK_POLLING_INTERVAL_MS = 200;
const DEFAULT_BATCH_INTERVAL_MS = 50;
const DEFAULT_SUBMIT_INTERVAL_MS = 400;

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

  const hasBatchOrder =
    config.sequencing !== undefined && "batchOrder" in config.sequencing;

  if (config.sequencing?.order === "batch" && hasBatchOrder === false) {
    throw new Error(
      "config.sequencing.batchOrder is required for batch ordering",
    );
  }

  if (config.sequencing?.order === "fifo" && hasBatchOrder) {
    throw new Error(
      "config.sequencing.batchOrder is only valid for batch ordering",
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

export function buildInternalApp(config: FFCAConfig): InternalApp {
  validateConfig(config);

  const rpcUrls = Array.isArray(config.rpcUrl)
    ? config.rpcUrl
    : [config.rpcUrl];
  const confirmations = {
    safeBlockDepth:
      config.confirmations?.safeBlockDepth ?? DEFAULT_SAFE_BLOCK_DEPTH,
    finalizedBlockDepth:
      config.confirmations?.finalizedBlockDepth ??
      DEFAULT_FINALIZED_BLOCK_DEPTH,
  };

  const sequencing =
    config.sequencing?.order === "batch"
      ? {
          order: "batch" as const,
          batchIntervalMs:
            config.sequencing.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS,
          submitIntervalMs:
            config.sequencing.submitIntervalMs ?? DEFAULT_SUBMIT_INTERVAL_MS,
          batchOrder: [...config.sequencing.batchOrder],
        }
      : {
          order: "fifo" as const,
          submitIntervalMs:
            config.sequencing?.submitIntervalMs ?? DEFAULT_SUBMIT_INTERVAL_MS,
        };

  return {
    address: config.address,
    domain: {
      name: config.domain.name,
      version: config.domain.version,
      chainId: config.chainId,
      verifyingContract: config.address,
    },
    signature: config.signature,
    storageLayout: config.storageLayout,
    account: config.account,
    chainId: config.chainId,
    rpcUrls,
    database: config.database,
    // @ts-expect-error
    mutations: config.mutations,
    schema: createMutationSchema(config),
    blockPollingIntervalMs:
      config.blockPollingIntervalMs ?? DEFAULT_BLOCK_POLLING_INTERVAL_MS,
    confirmations,
    onFatalError: config.onFatalError,
    sequencing,
  };
}
