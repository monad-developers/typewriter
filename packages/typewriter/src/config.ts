import type { AbiParameterToPrimitiveType } from "abitype";
import type { Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { Abi, AbiParameter, PrivateKeyAccount } from "viem";
import type { DatabaseClient, DatabaseOptions } from "./db";
import type { InternalApp } from "./internal";
import { createMutationSchema } from "./schema";
import {
  BUILTIN_MUTATIONS,
  FIRST_BUILTIN_MUTATION_ID,
} from "./typewriter-constants";

export type TypewriterDatabase = DatabaseClient;
export type TypewriterDatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];

export type StorageConfig = StorageLayout;
export type MutationConfig = {
  params: readonly AbiParameter[];
};
export type MutationsConfig = { [name: string]: MutationConfig };
export type SequencingConfig = "fifo" | "batch";

export type AbiParametersToValue<params extends readonly AbiParameter[]> =
  params extends readonly [
    infer head extends AbiParameter,
    ...infer tail extends readonly AbiParameter[],
  ]
    ? (head extends AbiParameter & { name: infer name extends string }
        ? { [key in name]: AbiParameterToPrimitiveType<head> }
        : unknown) &
        AbiParametersToValue<tail>
    : object;

export type ResolvedTypewriterMutationConfig = MutationConfig & {
  id: number;
};

export type TypewriterManifest<
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = {
  readonly chainId: number;
  readonly address: Address.Address;
  readonly mutations: {
    readonly [name in keyof mutationsConfig]: {
      readonly id: mutationsConfig[name] extends {
        readonly id: infer id extends number;
      }
        ? id
        : number;
      readonly params: mutationsConfig[name]["params"];
    };
  };
};

export type TypewriterSequencingConfig<
  sequencingConfig extends SequencingConfig,
> =
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

export type TypewriterConfig<
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  address: Address.Address;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  database: DatabaseOptions;
  blockPollingIntervalMs?: number;
  confirmations?: {
    finalizedBlockDepth?: number;
  };
  sequencing?: TypewriterSequencingConfig<sequencingConfig>;
};

const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;
const DEFAULT_BLOCK_POLLING_INTERVAL_MS = 200;
const DEFAULT_BATCH_INTERVAL_MS = 50;
const DEFAULT_SUBMIT_INTERVAL_MS = 300;

function assertSafeNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
}

export function validateConfig(config: TypewriterConfig): void {
  if (Array.isArray(config.rpcUrl) && config.rpcUrl.length === 0) {
    throw new Error("At least one RPC URL is required");
  }

  assertSafeNonNegativeInteger(
    config.blockPollingIntervalMs,
    "config.blockPollingIntervalMs",
  );

  assertSafeNonNegativeInteger(
    config.confirmations?.finalizedBlockDepth,
    "config.confirmations.finalizedBlockDepth",
  );

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
}

function validateMutationDefinitions(mutations: {
  readonly [name: string]: ResolvedTypewriterMutationConfig;
}): void {
  const mutationIDs = new Set<number>();
  for (const [name, mutation] of Object.entries(mutations)) {
    if (
      !Number.isSafeInteger(mutation.id) ||
      mutation.id < 0 ||
      mutation.id > 255
    ) {
      throw new Error(`mutation ID must be a uint8: ${mutation.id}`);
    }
    if (mutationIDs.has(mutation.id)) {
      throw new Error(`duplicate mutation ID: ${mutation.id}`);
    }
    if (
      !Object.hasOwn(BUILTIN_MUTATIONS, name) &&
      mutation.id >= FIRST_BUILTIN_MUTATION_ID
    ) {
      throw new Error(
        `app mutation ID must be below ${FIRST_BUILTIN_MUTATION_ID}: ${name}=${mutation.id}`,
      );
    }
    mutationIDs.add(mutation.id);
  }

  for (const [name, builtin] of Object.entries(BUILTIN_MUTATIONS)) {
    const mutation = mutations[name];
    if (mutation === undefined || mutation.id !== builtin.id) {
      throw new Error(
        `missing built-in mutation ${name} with ID ${builtin.id}`,
      );
    }
  }
}

export function buildInternalApp(params: {
  config: TypewriterConfig;
  abi: Abi;
  storageLayout: StorageConfig;
  mutations: { [name: string]: ResolvedTypewriterMutationConfig };
}): InternalApp {
  const { abi, config, mutations, storageLayout } = params;
  validateConfig(config);
  validateMutationDefinitions(mutations);

  const rpcUrls = Array.isArray(config.rpcUrl)
    ? config.rpcUrl
    : [config.rpcUrl];
  const confirmations = {
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
    abi,
    manifest: {
      chainId: config.chainId,
      address: config.address,
      mutations: Object.fromEntries(
        Object.entries(mutations).map(([name, mutation]) => [
          name,
          { id: mutation.id, params: mutation.params },
        ]),
      ),
    },
    storageLayout,
    account: config.account,
    chainId: config.chainId,
    rpcUrls,
    database: config.database,
    mutations: mutations as InternalApp["mutations"],
    schema: createMutationSchema({ mutations }),
    blockPollingIntervalMs:
      config.blockPollingIntervalMs ?? DEFAULT_BLOCK_POLLING_INTERVAL_MS,
    confirmations,
    sequencing,
  };
}
