import { Data, Duration, Effect } from "effect";
import { type Address, ContractAddress, Hash, Hex } from "ox";
import type { TypewriterApp } from "./config";
import type { Db } from "./db";
import { type MigrationError, readMetadata } from "./db-migrate";
import type { DbError } from "./db-transport";
import {
  encodeSchedulerCredentials,
  secp256k1SchedulerCredential,
} from "./encoding";
import { Rpc, type RpcError } from "./rpc";
import { requestNonce } from "./rpc-request";
import {
  MAX_FEE_PER_GAS,
  MAX_PRIORITY_FEE_PER_GAS,
  SchedulerRole,
} from "./typewriter-constants";
import type { SchedulerCredential } from "./typewriter-types";

/**
 * The standard CREATE2 deployer (Arachnid's deterministic deployment proxy).
 * Its calldata is a 32-byte salt and then the initcode, and it returns the
 * address it created. Monad and Anvil have it.
 */
export const CREATE2_DEPLOYER: Address.Address =
  "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** The one-time sender of `CREATE2_DEPLOYER_TRANSACTION`. */
export const CREATE2_DEPLOYER_SENDER: Address.Address =
  "0x3fab184622dc19b6109349b94811493bf2a45362";

/**
 * The keyless, pre-EIP-155 transaction that deploys `CREATE2_DEPLOYER` on any
 * chain that accepts it, from `CREATE2_DEPLOYER_SENDER` at nonce 0.
 */
const CREATE2_DEPLOYER_TRANSACTION: Hex.Hex =
  "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222";

/** What `CREATE2_DEPLOYER_TRANSACTION` costs: 100,000 gas at 100 gwei. */
const CREATE2_DEPLOYER_COST = 100_000n * 100_000_000_000n;

/** Monad's gas limit per transaction. */
const MAX_TRANSACTION_GAS = 30_000_000n;

/** How long startup waits for each transaction it sends to land. */
const RECEIPT_TIMEOUT = Duration.minutes(2);

/** Startup could not resolve, or create, its deployment. */
export class DeploymentError extends Data.TaggedError("DeploymentError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Whether this start deployed the contract (`created`), or resumed a
 * deployment that already existed (`resumed`).
 */
export type Migration = "created" | "resumed";

/**
 * The scheduler credentials that a deployment typewriter creates starts with,
 * none of which expire: the root, and an executor for the scheduler unless
 * the scheduler is the root. Credential 0 is the root.
 */
export function genesisCredentials(
  root: Address.Address,
  scheduler: Address.Address,
): SchedulerCredential[] {
  const credentials = [secp256k1SchedulerCredential(root, SchedulerRole.Root)];
  if (root.toLowerCase() !== scheduler.toLowerCase()) {
    credentials.push(
      secp256k1SchedulerCredential(scheduler, SchedulerRole.Executor),
    );
  }
  return credentials;
}

/**
 * The CREATE2 salt of the deployment named `deployment`, so each name deploys
 * to its own address.
 */
export function deploymentSalt(deployment: string): Hex.Hex {
  return Hash.keccak256(Hex.fromString(deployment));
}

/** `bytecode`, then the constructor's encoded scheduler credentials. */
export function deploymentInitcode(
  bytecode: Hex.Hex,
  credentials: readonly SchedulerCredential[],
): Hex.Hex {
  return Hex.concat(bytecode, encodeSchedulerCredentials(credentials));
}

/** Where `CREATE2_DEPLOYER` deploys `initcode` with `salt`. */
export function deploymentAddress(
  salt: Hex.Hex,
  initcode: Hex.Hex,
): Address.Address {
  return ContractAddress.fromCreate2({
    from: CREATE2_DEPLOYER,
    salt,
    bytecode: initcode,
  });
}

/**
 * keccak256 of `bytecode` without its trailing solc metadata, which hashes
 * the sources, comments included. Other changes count, even ones that
 * compile to the same code apart from the metadata of a contract that
 * `bytecode` embeds.
 */
export function creationCodeHash(bytecode: Hex.Hex): Hex.Hex {
  const size = Hex.size(bytecode);
  // The metadata is CBOR, then its length in two bytes. It starts with a map
  // and has a `solc` key.
  if (size >= 2) {
    const length = Hex.toNumber(Hex.slice(bytecode, size - 2));
    const start = size - 2 - length;
    if (length > 0 && start >= 0) {
      const metadata = Hex.slice(bytecode, start, size - 2);
      const head = Hex.toNumber(Hex.slice(metadata, 0, 1));
      if (head >= 0xa0 && head <= 0xbf && metadata.includes("64736f6c63")) {
        return Hash.keccak256(Hex.slice(bytecode, 0, start));
      }
    }
  }
  return Hash.keccak256(bytecode);
}

export type ResolvedDeployment = {
  address: Address.Address;
  migration: Migration;
  /** The block that the deployment landed in, when this start sent it. */
  deployedIn: bigint | undefined;
};

/**
 * The deployment named `app.deployment`: the one its schema recorded, else the
 * app deployed through `CREATE2_DEPLOYER` with a salt from the name.
 * That address is the same on every attempt, so a contract already there is
 * the one an earlier start sent before it could record it.
 *
 * @dev The caller must hold `db.lock(deploymentLockKey(app.schemaName))`.
 * @param existing - Internal, for the simulation only, whose chain mines only
 * once the runtime has started: a contract it deployed itself, which an empty
 * schema resumes instead of deploying.
 */
export function resolveDeployment(
  app: TypewriterApp,
  db: Db,
  existing?: Address.Address,
): Effect.Effect<
  ResolvedDeployment,
  DeploymentError | MigrationError | DbError | RpcError,
  Rpc
> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const name = app.deployment;
    const recorded = yield* readMetadata(
      db,
      app.schemaName,
      app.typewriterSchema,
    );

    if (recorded !== undefined) {
      if (recorded.chainId !== app.chainId) {
        return yield* new DeploymentError({
          message: `Deployment ${name} is at ${recorded.address} on chain ${recorded.chainId}, but config.chainId is ${app.chainId}; use another config.deployment for another chain`,
        });
      }
      if (recorded.creationCodeHash !== creationCodeHash(app.bytecode)) {
        return yield* new DeploymentError({
          message: `${app.contractName} changed since deployment ${name} was deployed at ${recorded.address}; to deploy the new code, use a new config.deployment`,
        });
      }
      yield* logDeployment("Resumed deployment", app, recorded.address);
      return {
        address: recorded.address,
        migration: "resumed" as const,
        deployedIn: undefined,
      };
    }

    if (existing !== undefined) {
      yield* logDeployment("Resumed deployment", app, existing);
      return {
        address: existing,
        migration: "resumed" as const,
        deployedIn: undefined,
      };
    }

    const initcode = deploymentInitcode(
      app.bytecode,
      genesisCredentials(app.root, app.scheduler.address),
    );
    const salt = deploymentSalt(name);
    const address = deploymentAddress(salt, initcode);

    const codeThere = yield* rpc.request({
      method: "eth_getCode",
      params: [address, "latest"],
    });
    if (codeThere !== "0x") {
      yield* logDeployment(
        "Adopted the deployment an earlier start sent",
        app,
        address,
      );
      return { address, migration: "created" as const, deployedIn: undefined };
    }

    yield* ensureCreate2Deployer(app);

    const data = Hex.concat(salt, initcode);
    const estimate = yield* rpc
      .request({
        method: "eth_estimateGas",
        params: [{ from: app.relayer.address, to: CREATE2_DEPLOYER, data }],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentError({
              message: `Failed to estimate the gas to deploy ${app.contractName}; its constructor must take the scheduler's credentials, \`constructor(SchedulerCredential[] memory schedulerCredentials)\`, and succeed with a root credential for ${app.root}`,
              cause,
            }),
        ),
        Effect.map(Hex.toBigInt),
      );
    if (estimate > MAX_TRANSACTION_GAS) {
      return yield* new DeploymentError({
        message: `Deploying ${app.contractName} takes ${estimate} gas, more than the ${MAX_TRANSACTION_GAS} a transaction can use on Monad`,
      });
    }
    // A margin for state that changes between the estimate and the block.
    const gas = min((estimate * 5n) / 4n, MAX_TRANSACTION_GAS);

    const receipt = yield* sendFromRelayer(
      app,
      { to: CREATE2_DEPLOYER, data, gas, value: 0n },
      `the deployment of ${app.contractName}`,
    );
    if (receipt.status !== "0x1") {
      return yield* new DeploymentError({
        message: `Deployment ${receipt.transactionHash} of ${app.contractName} reverted`,
      });
    }
    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [address, { blockHash: receipt.blockHash }],
    });
    if (code === "0x") {
      return yield* new DeploymentError({
        message: `Deployment ${receipt.transactionHash} of ${app.contractName} landed, but left no code at ${address}`,
      });
    }
    yield* logDeployment("Created deployment", app, address).pipe(
      Effect.annotateLogs({ transaction_hash: receipt.transactionHash }),
    );
    return {
      address,
      migration: "created" as const,
      deployedIn: Hex.toBigInt(receipt.blockNumber),
    };
  });
}

function logDeployment(
  message: string,
  app: TypewriterApp,
  address: Address.Address,
) {
  return Effect.logInfo(message).pipe(
    Effect.annotateLogs({
      deployment: app.deployment,
      chain_id: app.chainId,
      address,
    }),
  );
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Deploys `CREATE2_DEPLOYER` with its keyless transaction if the chain lacks
 * it, after the relayer funds the transaction's sender.
 */
function ensureCreate2Deployer(
  app: TypewriterApp,
): Effect.Effect<void, DeploymentError | RpcError, Rpc> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [CREATE2_DEPLOYER, "latest"],
    });
    if (code !== "0x") return;

    yield* Effect.logWarning(
      "Deploying the CREATE2 deployer, which the chain lacks",
    ).pipe(Effect.annotateLogs({ deployer: CREATE2_DEPLOYER }));
    const deployed = Effect.gen(function* () {
      const balance = Hex.toBigInt(
        yield* rpc.request({
          method: "eth_getBalance",
          params: [CREATE2_DEPLOYER_SENDER, "latest"],
        }),
      );
      if (balance < CREATE2_DEPLOYER_COST) {
        const funded = yield* sendFromRelayer(
          app,
          {
            to: CREATE2_DEPLOYER_SENDER,
            data: "0x",
            gas: 21_000n,
            value: CREATE2_DEPLOYER_COST - balance,
          },
          "the CREATE2 deployer's funding",
        );
        if (funded.status !== "0x1") {
          return yield* new DeploymentError({
            message: `Funding ${funded.transactionHash} of the CREATE2 deployer's sender reverted`,
          });
        }
      }
      const receipt = yield* sendAndWait(
        CREATE2_DEPLOYER_TRANSACTION,
        "the CREATE2 deployer",
        app.blockPollingIntervalMs,
      );
      const code = yield* rpc.request({
        method: "eth_getCode",
        params: [CREATE2_DEPLOYER, { blockHash: receipt.blockHash }],
      });
      if (receipt.status !== "0x1" || code === "0x") {
        return yield* new DeploymentError({
          message: `Transaction ${receipt.transactionHash} did not deploy the CREATE2 deployer`,
        });
      }
    });
    yield* deployed.pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentError({
            message: `Chain ${app.chainId} has no CREATE2 deployer at ${CREATE2_DEPLOYER}, and deploying it failed; deploy it, then restart`,
            cause,
          }),
      ),
    );
  });
}

/** Signs a transaction from the relayer, sends it, and waits for its receipt. */
function sendFromRelayer(
  app: TypewriterApp,
  transaction: {
    to: Address.Address;
    data: Hex.Hex;
    gas: bigint;
    value: bigint;
  },
  what: string,
) {
  return Effect.gen(function* () {
    const nonce = yield* requestNonce(app.relayer.address).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentError({
            message: `Failed to read the nonce of relayer ${app.relayer.address} for ${what}`,
            cause,
          }),
      ),
    );
    const signed = yield* Effect.tryPromise({
      try: () =>
        app.relayer.signTransaction({
          type: "eip1559",
          chainId: app.chainId,
          nonce,
          ...transaction,
          maxFeePerGas: MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
        }) as Promise<Hex.Hex>,
      catch: (cause) =>
        new DeploymentError({
          message: `Failed to sign ${what} with relayer ${app.relayer.address}`,
          cause,
        }),
    });
    return yield* sendAndWait(signed, what, app.blockPollingIntervalMs);
  });
}

/** Sends `signed` to every provider, and polls for its receipt. */
function sendAndWait(signed: Hex.Hex, what: string, pollingIntervalMs: number) {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const hash = Hash.keccak256(signed);
    yield* rpc
      .requestAll({ method: "eth_sendRawTransaction", params: [signed] })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentError({
              message: `Failed to send ${what} (${hash})`,
              cause,
            }),
        ),
      );
    const poll = Effect.gen(function* () {
      while (true) {
        const receipt = yield* rpc.request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        });
        if (receipt !== null) return receipt;
        yield* Effect.sleep(Duration.millis(Math.max(pollingIntervalMs, 100)));
      }
    });
    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: RECEIPT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new DeploymentError({
              message: `${capitalize(what)} (${hash}) did not land in ${Duration.format(RECEIPT_TIMEOUT)}; restart once it lands`,
            }),
          ),
      }),
    );
  });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
