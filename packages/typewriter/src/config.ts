import type { AbiParameterToPrimitiveType } from "abitype";
import type { PgTable } from "drizzle-orm/pg-core";
import { Data } from "effect";
import { Address, Hex } from "ox";
import type { StorageLayout } from "storage-layout";
import type { Spec } from "typewriter-evm";
import type { Abi, AbiParameter, LocalAccount } from "viem";
import type { DatabaseOptions } from "./db";
import {
  createMutationSchema,
  createTypewriterSchema,
  type TypewriterSchema,
} from "./db-schema";
import {
  BUILTIN_MUTATIONS,
  DEFAULT_HARDFORK,
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
   * The deployment's name, `config.deployment`, for clients to scope browser
   * storage by. In `dev` mode, where each process's chain is new, it is a
   * random `typewriter_dev_<random>`.
   */
  deployment: string;
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
    }
  | {
      order: sequencingConfig extends "batch" ? sequencingConfig : never;
      batchIntervalMs?: number;
      batchOrder: readonly string[];
    };

/** The fields that point typewriter at a deployment, which `dev` fills in. */
type ChainConfig = {
  /**
   * The deployment's name. One name is one contract, at the CREATE2 address
   * that the name salts, and one database schema of the same name: the first
   * start deploys the contract, and later starts resume it. A new name
   * deploys a new contract, which changed contract code needs. Lowercase
   * letters, digits, and underscores.
   */
  deployment: string;
  /**
   * The address of the deployment's root scheduler credential, which adds
   * and removes the scheduler's credentials. It is read only by the start
   * that deploys the contract.
   */
  root: Address.Address;
  /**
   * Authorizes each `execute`: the scheduler must have a live secp256k1
   * credential for its address, of any role. It signs each settlement for
   * `relayer` unless it is `relayer`. A deployment that typewriter creates
   * gives it an executor credential, unless it is `root`.
   */
  scheduler: LocalAccount;
  /**
   * Sends the deployment and the `execute` transactions: signs them, pays
   * their gas, and owns their nonces. Defaults to `scheduler`.
   */
  relayer?: LocalAccount;
  chainId: number;
  rpcUrl: string | string[];
};

/**
 * A literal `dev: true` leaves the chain fields unset, and `false` or no
 * `dev` sets them all. A `dev` typed as `boolean`, such as one read from the
 * environment, allows either, and `validateConfig` checks it at startup.
 */
type DevChainConfig<dev extends boolean> = boolean extends dev
  ? Partial<ChainConfig>
  : dev extends true
    ? { [field in keyof ChainConfig]?: undefined }
    : ChainConfig;

export type TypewriterConfig<
  sequencingConfig extends SequencingConfig = SequencingConfig,
  dev extends boolean = boolean,
> = DevChainConfig<dev> & {
  /**
   * Starts a local Anvil and deploys the app to it with Anvil's first
   * account as the root, the scheduler, and the relayer. The chain and the
   * deployment's schema last only as long as the process, so the chain
   * fields, `deployment` included, stay unset.
   */
  dev?: dev;
  /**
   * The EVM hardfork that mutations execute under and settlements are priced
   * for, for the runtime's life. Defaults to `DEFAULT_HARDFORK` (MonadTen).
   */
  hardfork?: Spec;
  database: DatabaseOptions;
  blockPollingIntervalMs?: number;
  sequencing?: TypewriterSequencingConfig<sequencingConfig>;
};

/** The Anvil that `dev` mode started, which fills in the chain fields. */
export type DevChain = {
  /** Anvil's first account: the deployment's root, scheduler, and relayer. */
  account: LocalAccount;
  chainId: number;
  hardfork: Spec;
  rpcUrl: string;
};

const REQUIRED_CHAIN_FIELDS = [
  "deployment",
  "root",
  "scheduler",
  "chainId",
  "rpcUrl",
] as const;
const CHAIN_FIELDS = [...REQUIRED_CHAIN_FIELDS, "relayer"] as const;

/**
 * A resolved `TypewriterConfig`, merged with the app's Solidity metadata.
 * Startup resolves the deployment's address, under the deployment lock.
 */
export type TypewriterApp = {
  /** Set in `dev` mode, where the deployment's schema starts empty. */
  dev: boolean;
  contractName: string;
  abi: Abi;
  /** Creation bytecode, without constructor arguments. */
  bytecode: Hex.Hex;
  storageLayout: StorageLayout;
  /** The root credential's address, for a deployment that startup creates. */
  root: Address.Address;
  /** Authorizes each `execute` with its scheduler credential. */
  scheduler: LocalAccount;
  /**
   * Sends the deployment and the `execute` transactions: `config.relayer`,
   * or else `scheduler`.
   */
  relayer: LocalAccount;
  chainId: number;
  hardfork: Spec;
  rpcUrls: [string, ...string[]];
  database: DatabaseOptions;
  mutations: { [name: string]: ResolvedTypewriterMutationConfig };
  /**
   * `config.deployment`, or in `dev` mode a random `typewriter_dev_<random>`:
   * the CREATE2 salt's preimage, `manifest.deployment`, and the Postgres
   * schema that holds the deployment's tables.
   */
  deployment: string;
  typewriterSchema: TypewriterSchema;
  mutationSchema: Record<string, PgTable>;
  blockPollingIntervalMs: number;
  sequencing:
    | {
        order: "fifo";
      }
    | {
        order: "batch";
        batchIntervalMs: number;
        batchOrder: string[];
      };
};

/** A `TypewriterApp` with its deployment's address resolved. */
export type DeployedTypewriterApp = TypewriterApp & {
  address: Address.Address;
  manifest: TypewriterManifest;
};

/** `app` with its deployment at `address`. */
export function deployedApp(
  app: TypewriterApp,
  address: Address.Address,
): DeployedTypewriterApp {
  return {
    ...app,
    address,
    manifest: {
      chainId: app.chainId,
      address,
      deployment: app.deployment,
      mutations: Object.fromEntries(
        Object.entries(app.mutations).map(([name, mutation]) => [
          name,
          { id: mutation.id, params: mutation.params },
        ]),
      ),
    },
  };
}

/** Postgres truncates longer identifiers. */
const MAX_IDENTIFIER_LENGTH = 63;

const DEFAULT_BLOCK_POLLING_INTERVAL_MS = 200;
const DEFAULT_BATCH_INTERVAL_MS = 50;

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

/**
 * A deployment name that is also a schema name that needs no quoting, so it
 * reads the same in `psql`. Postgres reserves `pg_` names for its own
 * schemas.
 */
function validateDeploymentName(deployment: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(deployment) || deployment.startsWith("pg_")) {
    throw new ConfigError({
      message: `config.deployment must be lowercase letters, digits, and underscores, start with a letter or underscore, and not start with pg_, but is ${JSON.stringify(deployment)}`,
    });
  }
  if (deployment.length > MAX_IDENTIFIER_LENGTH) {
    throw new ConfigError({
      message: `config.deployment must be at most ${MAX_IDENTIFIER_LENGTH} characters, but ${deployment} has ${deployment.length}`,
    });
  }
}

export function validateConfig(config: TypewriterConfig): void {
  if (config.dev === true) {
    const set = CHAIN_FIELDS.filter((field) => config[field] !== undefined);
    if (set.length > 0) {
      throw new ConfigError({
        message: `config.dev starts its own Anvil and deployment, so leave ${set.map((field) => `config.${field}`).join(", ")} unset`,
      });
    }
  } else {
    const missing = REQUIRED_CHAIN_FIELDS.filter(
      (field) => config[field] === undefined,
    );
    if (missing.length > 0) {
      throw new ConfigError({
        message: `${missing.map((field) => `config.${field}`).join(", ")} ${missing.length === 1 ? "is" : "are"} required unless config.dev is set`,
      });
    }
    validateDeploymentName(config.deployment!);
  }

  if (
    config.root !== undefined &&
    !Address.validate(config.root, { strict: false })
  ) {
    throw new ConfigError({
      message: `config.root must be an address, but is ${JSON.stringify(config.root)}`,
    });
  }

  if (Array.isArray(config.rpcUrl) && config.rpcUrl.length === 0) {
    throw new ConfigError({ message: "At least one RPC URL is required" });
  }

  assertSafeNonNegativeInteger(
    config.blockPollingIntervalMs,
    "config.blockPollingIntervalMs",
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

/** `batchOrder` after the built-in mutations, which always come first. */
function resolveBatchOrder(
  batchOrder: readonly string[],
  mutations: { readonly [name: string]: ResolvedTypewriterMutationConfig },
): string[] {
  for (const name of batchOrder) {
    if (!Object.hasOwn(mutations, name)) {
      throw new ConfigError({
        message: `config.sequencing.batchOrder names ${name}, which is not a mutation`,
      });
    }
  }
  const builtIns = Object.keys(BUILTIN_MUTATIONS);
  return [
    ...builtIns,
    ...batchOrder.filter((name) => !builtIns.includes(name)),
  ];
}

export function createTypewriterApp(params: {
  config: TypewriterConfig;
  contractName: string;
  abi: Abi;
  /** Creation bytecode, without constructor arguments. */
  bytecode: Hex.Hex;
  storageLayout: StorageConfig;
  mutations: { [name: string]: ResolvedTypewriterMutationConfig };
  /** The started Anvil, required in `dev` mode. */
  devChain?: DevChain;
}): TypewriterApp {
  const { abi, bytecode, config, contractName, devChain, mutations } = params;
  validateConfig(config);
  validateMutationDefinitions(mutations);

  const dev = config.dev === true;
  if (dev && devChain === undefined) {
    throw new ConfigError({
      message: "config.dev needs a started Anvil; use createTypewriter",
    });
  }
  // `validateConfig` checked that the chain fields are set outside `dev`.
  const chain = dev
    ? {
        root: devChain!.account.address,
        scheduler: devChain!.account,
        relayer: devChain!.account,
        chainId: devChain!.chainId,
        hardfork: devChain!.hardfork,
        rpcUrl: devChain!.rpcUrl,
      }
    : {
        root: config.root!,
        scheduler: config.scheduler!,
        relayer: config.relayer,
        chainId: config.chainId!,
        hardfork: config.hardfork,
        rpcUrl: config.rpcUrl!,
      };

  // `validateConfig` rejects an empty `rpcUrl` list.
  const rpcUrls = (
    Array.isArray(chain.rpcUrl) ? chain.rpcUrl : [chain.rpcUrl]
  ) as [string, ...string[]];

  // Each `dev` process gets its own deployment: its own schema, so dev
  // processes can share a database, and its own browser storage, so a client
  // does not reuse an account from a chain that is gone.
  const deployment = dev
    ? `typewriter_dev_${Hex.random(6).slice(2)}`
    : config.deployment!;
  const sequencing =
    config.sequencing?.order === "batch"
      ? {
          order: "batch" as const,
          batchIntervalMs:
            config.sequencing.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS,
          batchOrder: resolveBatchOrder(
            config.sequencing.batchOrder,
            mutations,
          ),
        }
      : { order: "fifo" as const };

  return {
    dev,
    contractName,
    abi,
    bytecode,
    storageLayout: params.storageLayout,
    root: chain.root,
    scheduler: chain.scheduler,
    relayer: chain.relayer ?? chain.scheduler,
    chainId: chain.chainId,
    hardfork: chain.hardfork ?? DEFAULT_HARDFORK,
    rpcUrls,
    database: config.database,
    mutations,
    deployment,
    // The deployment's schema has its name, which `validateConfig` checked.
    typewriterSchema: createTypewriterSchema(deployment),
    mutationSchema: createMutationSchema(deployment, { mutations }),
    blockPollingIntervalMs:
      config.blockPollingIntervalMs ?? DEFAULT_BLOCK_POLLING_INTERVAL_MS,
    sequencing,
  };
}
