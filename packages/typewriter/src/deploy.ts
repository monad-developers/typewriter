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
import { TX_GAS_LIMIT_CAP } from "./gas";
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
 * address it created. Monad and Anvil have it; startup fails on a chain
 * without it.
 */
export const CREATE2_DEPLOYER: Address.Address =
  "0x4e59b44847b379578588920cA78FbF26c0B4956C";

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
  /**
   * The block that the deployment landed in, when this start sent it, so the
   * runtime starts no earlier.
   */
  deployedIn: bigint | undefined;
};

/**
 * The deployment named `app.deployment`: the one its schema recorded, else the
 * app deployed through `CREATE2_DEPLOYER` with a salt from the name.
 * That address is the same on every attempt, so a contract already there is
 * the one an earlier start sent before it could record it.
 *
 * @dev The caller must hold `db.lock(deploymentLockKey(app.deployment))`.
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
      app.deployment,
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

    const [codeThere, deployerCode] = yield* Effect.all(
      [address, CREATE2_DEPLOYER].map((at) =>
        rpc.request({ method: "eth_getCode", params: [at, "latest"] }),
      ),
      { concurrency: "unbounded" },
    );
    // The schema has no deployment, but the chain does: the database was
    // wiped or is another one, or an earlier start crashed after deploying.
    if (codeThere !== "0x") {
      return yield* new DeploymentError({
        message: `${app.contractName} is already deployed at ${address} for deployment ${name}, but schema ${name} doesn't record it; restore the database, or use a new config.deployment`,
      });
    }
    if (deployerCode === "0x") {
      return yield* new DeploymentError({
        message: `Chain ${app.chainId} lacks the standard CREATE2 deployer at ${CREATE2_DEPLOYER}, which Typewriter deploys ${app.contractName} through`,
      });
    }

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
              message: `Failed to estimate the gas to deploy ${app.contractName}; its constructor must take the scheduler's credentials, \`constructor(SchedulerCredential[] memory schedulerCredentials)\`, and succeed with a root credential for ${app.root}. Or ${address} already has code that a provider did not show at startup, so the CREATE2 deployer reverts`,
              cause,
            }),
        ),
        Effect.map(Hex.toBigInt),
      );
    if (estimate > BigInt(TX_GAS_LIMIT_CAP)) {
      return yield* new DeploymentError({
        message: `Deploying ${app.contractName} takes ${estimate} gas, more than the ${TX_GAS_LIMIT_CAP} a transaction can use on Monad`,
      });
    }
    // A margin for state that changes between the estimate and the block.
    const gas = BigInt(
      Math.min(Math.floor((Number(estimate) * 5) / 4), TX_GAS_LIMIT_CAP),
    );

    const receipt = yield* sendFromRelayer(app, {
      to: CREATE2_DEPLOYER,
      data,
      gas,
    });
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

/**
 * Signs the deployment's transaction from the relayer, sends it to every
 * provider, and polls for its receipt.
 */
function sendFromRelayer(
  app: TypewriterApp,
  transaction: { to: Address.Address; data: Hex.Hex; gas: bigint },
) {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const what = `the deployment of ${app.contractName}`;
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
          value: 0n,
          maxFeePerGas: MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
        }) as Promise<Hex.Hex>,
      catch: (cause) =>
        new DeploymentError({
          message: `Failed to sign ${what} with relayer ${app.relayer.address}`,
          cause,
        }),
    });
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
        yield* Effect.sleep(
          Duration.millis(Math.max(app.blockPollingIntervalMs, 100)),
        );
      }
    });
    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: RECEIPT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new DeploymentError({
              message: `The deployment of ${app.contractName} (${hash}) did not land in ${Duration.format(RECEIPT_TIMEOUT)}; restart once it lands`,
            }),
          ),
      }),
    );
  });
}
