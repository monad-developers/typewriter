import type { AbiParameterToPrimitiveType } from "abitype";
import type { PgTable } from "drizzle-orm/pg-core";
import { Data } from "effect";
import type { Address } from "ox";
import type { StorageLayout } from "storage-layout";
import type { Spec } from "typewriter-evm";
import type { Abi, AbiParameter, PrivateKeyAccount } from "viem";
import { deploymentKey } from "./client";
import type { DatabaseOptions } from "./db";
import {
  createMutationSchema,
  createTypewriterSchema,
  type TypewriterSchema,
} from "./db-schema";
import {
  BUILTIN_MUTATIONS,
  FIRST_BUILTIN_MUTATION_ID,
} from "./typewriter-constants";

/** An invalid typewriter config or Solidity entrypoint. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  message: string;
  cause?: unknown;
}> {}

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
  chainId: number;
  address: Address.Address;
  mutations: {
    [name in keyof mutationsConfig]: {
      id: mutationsConfig[name] extends {
        id: infer id extends number;
      }
        ? id
        : number;
      params: mutationsConfig[name]["params"];
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
  /**
   * Pins the EVM hardfork that mutations execute under. By default it follows
   * the Monad mainnet or testnet schedule for `chainId`, so it is required on
   * any other chain, such as a local Anvil started with `--network monad`.
   */
  hardfork?: Spec;
  rpcUrl: string | string[];
  database: DatabaseOptions;
  blockPollingIntervalMs?: number;
  /**
   * The seconds past the latest block's timestamp that an authorization or
   * credential must stay valid for a mutation to be accepted. A mutation that
   * expires before its settlement lands reverts the settlement, so this covers
   * the time from acceptance to inclusion.
   */
  expirationMarginS?: number;
  confirmations?: {
    finalizedBlockDepth?: number;
  };
  sequencing?: TypewriterSequencingConfig<sequencingConfig>;
};

/** A resolved `TypewriterConfig`, merged with the app's Solidity metadata. */
export type TypewriterApp = {
  address: Address.Address;
  abi: Abi;
  manifest: TypewriterManifest;
  storageLayout: StorageLayout;
  account: PrivateKeyAccount;
  chainId: number;
  hardfork: Spec | undefined;
  rpcUrls: [string, ...string[]];
  database: DatabaseOptions;
  mutations: { [name: string]: ResolvedTypewriterMutationConfig };
  /** The Postgres schema that holds the deployment's tables. */
  schemaName: string;
  typewriterSchema: TypewriterSchema;
  mutationSchema: Record<string, PgTable>;
  blockPollingIntervalMs: number;
  expirationMarginS: number;
  confirmations: {
    finalizedBlockDepth: number;
  };
  sequencing:
    | {
        order: "fifo";
        submitIntervalMs: number;
      }
    | {
        order: "batch";
        batchIntervalMs: number;
        submitIntervalMs: number;
        batchOrder: string[];
      };
};

/** Postgres truncates longer identifiers. */
const MAX_IDENTIFIER_LENGTH = 63;

const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;
const DEFAULT_BLOCK_POLLING_INTERVAL_MS = 200;
const DEFAULT_BATCH_INTERVAL_MS = 50;
const DEFAULT_SUBMIT_INTERVAL_MS = 300;
const DEFAULT_EXPIRATION_MARGIN_S = 5;

function assertSafeNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError({
      message: `${name} must be a safe non-negative integer`,
    });
  }
}

export function validateConfig(config: TypewriterConfig): void {
  if (Array.isArray(config.rpcUrl) && config.rpcUrl.length === 0) {
    throw new ConfigError({ message: "At least one RPC URL is required" });
  }

  assertSafeNonNegativeInteger(
    config.blockPollingIntervalMs,
    "config.blockPollingIntervalMs",
  );

  assertSafeNonNegativeInteger(
    config.expirationMarginS,
    "config.expirationMarginS",
  );

  assertSafeNonNegativeInteger(
    config.confirmations?.finalizedBlockDepth,
    "config.confirmations.finalizedBlockDepth",
  );

  const hasBatchOrder =
    config.sequencing !== undefined && "batchOrder" in config.sequencing;

  if (config.sequencing?.order === "batch" && hasBatchOrder === false) {
    throw new ConfigError({
      message: "config.sequencing.batchOrder is required for batch ordering",
    });
  }

  if (config.sequencing?.order === "fifo" && hasBatchOrder) {
    throw new ConfigError({
      message: "config.sequencing.batchOrder is only valid for batch ordering",
    });
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
      throw new ConfigError({
        message: `Mutation ${name} has ID ${mutation.id}; mutation IDs must be uint8s`,
      });
    }
    if (mutationIDs.has(mutation.id)) {
      throw new ConfigError({
        message: `Mutation ${name} reuses mutation ID ${mutation.id}`,
      });
    }
    if (
      !Object.hasOwn(BUILTIN_MUTATIONS, name) &&
      mutation.id >= FIRST_BUILTIN_MUTATION_ID
    ) {
      throw new ConfigError({
        message: `Mutation ${name} has reserved mutation ID ${mutation.id}; app mutation IDs must be below ${FIRST_BUILTIN_MUTATION_ID}`,
      });
    }
    mutationIDs.add(mutation.id);
  }

  for (const [name, builtin] of Object.entries(BUILTIN_MUTATIONS)) {
    const mutation = mutations[name];
    if (mutation === undefined || mutation.id !== builtin.id) {
      throw new ConfigError({
        message: `Could not find built-in mutation ${name} with ID ${builtin.id}`,
      });
    }
  }
}

export function createTypewriterApp(params: {
  config: TypewriterConfig;
  abi: Abi;
  storageLayout: StorageConfig;
  mutations: { [name: string]: ResolvedTypewriterMutationConfig };
}): TypewriterApp {
  const { abi, config, mutations, storageLayout } = params;
  validateConfig(config);
  validateMutationDefinitions(mutations);

  // `validateConfig` rejects an empty `rpcUrl` list.
  const rpcUrls = (
    Array.isArray(config.rpcUrl) ? config.rpcUrl : [config.rpcUrl]
  ) as [string, ...string[]];

  const schemaName = `typewriter_${deploymentKey(config.chainId, config.address)}`;
  if (schemaName.length > MAX_IDENTIFIER_LENGTH) {
    throw new ConfigError({
      message: `config.chainId is too long for the Postgres schema name: ${schemaName}`,
    });
  }
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
    hardfork: config.hardfork,
    rpcUrls,
    database: config.database,
    mutations,
    schemaName,
    typewriterSchema: createTypewriterSchema(schemaName),
    mutationSchema: createMutationSchema(schemaName, { mutations }),
    blockPollingIntervalMs:
      config.blockPollingIntervalMs ?? DEFAULT_BLOCK_POLLING_INTERVAL_MS,
    expirationMarginS: config.expirationMarginS ?? DEFAULT_EXPIRATION_MARGIN_S,
    confirmations,
    sequencing,
  };
}
