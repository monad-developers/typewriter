import type { AbiParameterToPrimitiveType } from "abitype";
import type { PgTable } from "drizzle-orm/pg-core";
import { Data } from "effect";
import { type Address, Hex } from "ox";
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
  /**
   * Identifies this deployment, for clients to scope browser storage by. It
   * is `deploymentKey(chainId, address)`, except in `dev` mode, where every
   * chain deploys to the same address and each process gets a random key.
   */
  deploymentKey: string;
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

/** The fields that point typewriter at a deployment, which `dev` fills in. */
type NetworkConfig = {
  /** The deployed Typewriter contract. */
  address: Address.Address;
  /** The scheduler, which signs and submits settlements. */
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
};

/**
 * A literal `dev: true` leaves the network fields unset, and `false` or no
 * `dev` sets them all. A `dev` typed as `boolean`, such as one read from the
 * environment, allows either, and `validateConfig` checks it at startup.
 */
type DevNetworkConfig<dev extends boolean> = boolean extends dev
  ? Partial<NetworkConfig>
  : dev extends true
    ? { [field in keyof NetworkConfig]?: undefined }
    : NetworkConfig;

export type TypewriterConfig<
  sequencingConfig extends SequencingConfig = SequencingConfig,
  dev extends boolean = boolean,
> = DevNetworkConfig<dev> & {
  /**
   * Starts a local Anvil and deploys the app to it with Anvil's first
   * account as the scheduler. The chain and the deployment's database schema
   * last only as long as the process, so the network fields stay unset.
   */
  dev?: dev;
  /**
   * Pins the EVM hardfork that mutations execute under. By default it follows
   * the Monad mainnet or testnet schedule for `chainId`, so it is required on
   * any other chain, such as a local Anvil started with `--network monad`.
   */
  hardfork?: Spec;
  database: DatabaseOptions;
  blockPollingIntervalMs?: number;
  confirmations?: {
    finalizedBlockDepth?: number;
  };
  sequencing?: TypewriterSequencingConfig<sequencingConfig>;
};

/** The network fields of a `TypewriterConfig`, filled in by `dev` mode. */
export type DevChain = {
  address: Address.Address;
  account: PrivateKeyAccount;
  chainId: number;
  hardfork: Spec;
  rpcUrl: string;
};

const NETWORK_FIELDS = ["address", "account", "chainId", "rpcUrl"] as const;

/** A resolved `TypewriterConfig`, merged with the app's Solidity metadata. */
export type TypewriterApp = {
  /** Set in `dev` mode, where the deployment's schema starts empty. */
  dev: boolean;
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
  if (config.dev === true) {
    const set = NETWORK_FIELDS.filter((field) => config[field] !== undefined);
    if (set.length > 0) {
      throw new ConfigError({
        message: `config.dev starts its own Anvil, so leave ${set.map((field) => `config.${field}`).join(", ")} unset`,
      });
    }
  } else {
    const missing = NETWORK_FIELDS.filter(
      (field) => config[field] === undefined,
    );
    if (missing.length > 0) {
      throw new ConfigError({
        message: `${missing.map((field) => `config.${field}`).join(", ")} ${missing.length === 1 ? "is" : "are"} required unless config.dev is set`,
      });
    }
  }

  if (Array.isArray(config.rpcUrl) && config.rpcUrl.length === 0) {
    throw new ConfigError({ message: "At least one RPC URL is required" });
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
  /** The started Anvil, required in `dev` mode. */
  devChain?: DevChain;
}): TypewriterApp {
  const { abi, config, devChain, mutations, storageLayout } = params;
  validateConfig(config);
  validateMutationDefinitions(mutations);

  const dev = config.dev === true;
  if (dev && devChain === undefined) {
    throw new ConfigError({
      message: "config.dev needs a started Anvil; use createTypewriter",
    });
  }
  // `validateConfig` checked that the network fields are set outside `dev`.
  const network = dev
    ? devChain!
    : {
        address: config.address!,
        account: config.account!,
        chainId: config.chainId!,
        hardfork: config.hardfork,
        rpcUrl: config.rpcUrl!,
      };

  // `validateConfig` rejects an empty `rpcUrl` list.
  const rpcUrls = (
    Array.isArray(network.rpcUrl) ? network.rpcUrl : [network.rpcUrl]
  ) as [string, ...string[]];

  // Every `dev` chain deploys to the same address, so each process gets its
  // own key: its own schema, so dev processes can share a database, and its
  // own browser storage, so a client does not reuse an account from a chain
  // that is gone.
  const key = dev
    ? `dev_${Hex.random(6).slice(2)}`
    : deploymentKey(network.chainId, network.address);
  const schemaName = `typewriter_${key}`;
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
    dev,
    address: network.address,
    abi,
    manifest: {
      chainId: network.chainId,
      address: network.address,
      deploymentKey: key,
      mutations: Object.fromEntries(
        Object.entries(mutations).map(([name, mutation]) => [
          name,
          { id: mutation.id, params: mutation.params },
        ]),
      ),
    },
    storageLayout,
    account: network.account,
    chainId: network.chainId,
    hardfork: network.hardfork,
    rpcUrls,
    database: config.database,
    mutations,
    schemaName,
    typewriterSchema: createTypewriterSchema(schemaName),
    mutationSchema: createMutationSchema(schemaName, { mutations }),
    blockPollingIntervalMs:
      config.blockPollingIntervalMs ?? DEFAULT_BLOCK_POLLING_INTERVAL_MS,
    confirmations,
    sequencing,
  };
}
