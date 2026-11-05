import type { AbiParameter } from "abitype";
import type { Deferred } from "effect";
import type { Hex } from "ox";
import type {
  AbiParametersToValue,
  MutationConfig,
  MutationsConfig,
  ResolvedTypewriterMutationConfig,
  SequencingConfig,
} from "./config";
import type { KeyType } from "./typewriter-constants";
import type { ExecuteMutationError } from "./typewriter-errors";

export type { KeyType };

// TODO(kyle) type the `uint40` `expiration` fields here as `number`, as abitype,
// ox, viem and storage-layout do. Then drop the `Number(...)` in
// `getAuthorizationPayload`, the `BigInt(...)` in `decodeAuthorizationCalldata`,
// and use `mode: "number"` for `authorization_expiration` in `db-schema.ts`.
export type Credential = {
  expiration: bigint;
  keyType: KeyType;
  permissions: bigint;
  publicKey: Hex.Hex;
};

export type Authorization = {
  accountID: Hex.Hex;
  credentialID: bigint;
  nonce: bigint;
  expiration: bigint;
  signature: Hex.Hex;
};

export type Account = {
  nonces: Readonly<Record<`${bigint}`, bigint>>;
  credentials: Credential[];
  activeCredentials: bigint;
};

export type CreateAccountParams = {
  keyType: KeyType;
  publicKey: Hex.Hex;
};

export type AddCredentialParams = {
  expiration: bigint;
  keyType: KeyType;
  permissions: bigint;
  publicKey: Hex.Hex;
};

export type RemoveCredentialParams = {
  credentialID: bigint;
};

/**
 * An integer as `execute` takes it: a bigint, a safe integer, or a decimal or
 * `0x` string. `execute` decodes it to a bigint.
 */
export type IntegerInput = bigint | number | string;

export type AuthorizationInput = {
  accountID: Hex.Hex;
  credentialID: IntegerInput;
  nonce: IntegerInput;
  expiration: IntegerInput;
  signature: Hex.Hex;
};

export type AddCredentialParamsInput = {
  expiration: IntegerInput;
  keyType: KeyType;
  permissions: IntegerInput;
  publicKey: Hex.Hex;
};

export type RemoveCredentialParamsInput = {
  credentialID: IntegerInput;
};

/** `value` with each integer as `integer`. */
type WithIntegers<value, integer> = value extends bigint | number
  ? integer
  : value extends object
    ? { [key in keyof value]: WithIntegers<value[key], integer> }
    : value;

type MutationParams<
  mutationConfig extends MutationConfig,
  integer,
> = readonly AbiParameter[] extends mutationConfig["params"]
  ? unknown
  : WithIntegers<AbiParametersToValue<mutationConfig["params"]>, integer>;

/** The params of a mutation as `execute` decodes them. */
export type MutationParamsForName<
  name extends string,
  mutationConfig extends MutationConfig,
> = name extends "CreateAccount"
  ? CreateAccountParams
  : name extends "AddCredential"
    ? AddCredentialParams
    : name extends "RemoveCredential"
      ? RemoveCredentialParams
      : MutationParams<mutationConfig, bigint>;

/** The params of a mutation as `execute` takes them. */
export type MutationParamsInputForName<
  name extends string,
  mutationConfig extends MutationConfig,
> = name extends "CreateAccount"
  ? CreateAccountParams
  : name extends "AddCredential"
    ? AddCredentialParamsInput
    : name extends "RemoveCredential"
      ? RemoveCredentialParamsInput
      : MutationParams<mutationConfig, IntegerInput>;

export type TypewriterMutation<
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
> = {
  name: name;
  params: MutationParamsForName<name, mutationConfig>;
  authorization: Authorization;
};

export type TypewriterMutationInput<
  mutationsConfig extends Record<string, MutationConfig>,
  name extends keyof mutationsConfig & string = keyof mutationsConfig & string,
> = {
  [name in keyof mutationsConfig & string]: {
    name: name;
    params: MutationParamsInputForName<name, mutationsConfig[name]>;
    authorization: AuthorizationInput;
  };
}[name];

export type TypewriterMutationResult = { executionIndex: bigint };

export type MutationStatus =
  | "received"
  | "accepted"
  | "rejected"
  | "included"
  | "finalized";

export type BatchStatus = "accepted" | "included" | "finalized";
export type BlockStatus = "included" | "finalized";

type MutationBase = {
  name: string;
  params: unknown;
  authorization: Authorization;
  config: ResolvedTypewriterMutationConfig;
};

/** Set when the mutation executes against the speculative state. */
type Execution = {
  /** The `execution_index` primary key of the mutation's row. */
  executionIndex: bigint;
};

/** Mirrors the `block_*` and `transaction_*` columns of a mutation row. */
export type Inclusion = {
  blockNumber: bigint;
  blockHash: Hex.Hex;
  blockTimestamp: bigint;
  transactionHash: Hex.Hex;
  transactionIndex: number;
};

/**
 * A mutation from `execute`. An `enqueue` is not one: revm force-executes it
 * from its bytes, and it has no events or mutation row.
 */
export type ReceivedMutation = MutationBase & { status: "received" };
export type AcceptedMutation = MutationBase &
  Execution & { status: "accepted" };
export type IncludedMutation = MutationBase &
  Execution &
  Inclusion & { status: "included" | "finalized" };
export type RejectedMutation = MutationBase & {
  status: "rejected";
  error: ExecuteMutationError;
};

export type RuntimeMutation =
  | ReceivedMutation
  | AcceptedMutation
  | IncludedMutation
  | RejectedMutation;

export type RuntimeBatch = {
  status: BatchStatus;
  id: number;
  mutations: (AcceptedMutation | IncludedMutation)[];
};

export type RuntimeBlock = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  batches: RuntimeBatch[];
};

type SettlementBase = {
  /** The timestamp it executes at, onchain as in revm. */
  timestamp: bigint;
  /** The `executionHash` and `executionIndex` it starts from. */
  fromExecutionHash: Hex.Hex;
  fromExecutionIndex: bigint;
  batch: RuntimeBatch | undefined;
  queueIndexes: bigint[];
  /** The revm journals of its executions. */
  journalIds: number[];
  gasLimit: number;
  /** Resolves once its executions' rows commit. */
  committed: Deferred.Deferred<void>;
};

type Transmission = {
  nonce: number;
  raw: Hex.Hex;
  hash: Hex.Hex;
  /** The block numbers when it was last and first broadcast. */
  sentAt: bigint;
  firstSentAt: bigint;
};

/** One settlement transaction: a batch, then the enqueues it force-executes. */
export type ExecutedSettlement = SettlementBase & { status: "executed" };
export type SigningSettlement = SettlementBase & {
  status: "signing";
  nonce: number;
};
export type SentSettlement = SettlementBase & Transmission & { status: "sent" };
export type LandedSettlement = SettlementBase &
  Transmission & { status: "included" | "reverted"; block: RuntimeBlock };

export type RuntimeSettlement =
  | ExecutedSettlement
  | SigningSettlement
  | SentSettlement
  | LandedSettlement;

/** Fields of a runtime mutation that listeners never see. */
type RuntimeOnlyField = "config";

type ToMutationEvent<
  mutation,
  name extends string,
  params,
> = mutation extends unknown
  ? Omit<mutation, RuntimeOnlyField | "name" | "params"> & {
      name: name;
      params: params;
    }
  : never;

export type MutationEvent<
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = {
  [name in keyof mutationsConfig & string]: ToMutationEvent<
    RuntimeMutation,
    name,
    MutationParamsForName<name, mutationsConfig[name]>
  >;
}[keyof mutationsConfig & string];

type AcceptedMutationEvent<mutationsConfig extends MutationsConfig> = Extract<
  MutationEvent<mutationsConfig>,
  { status: "accepted" }
>;
type IncludedMutationEvent<mutationsConfig extends MutationsConfig> = Extract<
  MutationEvent<mutationsConfig>,
  { status: "included" | "finalized" }
>;

export type BatchEvent<
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = { id: number } & (
  | { status: "accepted"; mutations: AcceptedMutationEvent<mutationsConfig>[] }
  | {
      status: "included" | "finalized";
      mutations: IncludedMutationEvent<mutationsConfig>[];
    }
);

export type BlockEvent<
  sequence extends SequencingConfig = SequencingConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
} & (sequence extends "fifo"
  ? { mutations: IncludedMutationEvent<mutationsConfig>[] }
  : {
      batches: Extract<
        BatchEvent<mutationsConfig>,
        { status: "included" | "finalized" }
      >[];
    });

export type MutationListener<
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = (event: MutationEvent<mutationsConfig>) => void;
export type BatchListener<
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = (event: BatchEvent<mutationsConfig>) => void;
export type BlockListener<
  sequence extends SequencingConfig = SequencingConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = (event: BlockEvent<sequence, mutationsConfig>) => void;

/**
 * The `on` overloads. Each returns `unsubscribe`, wrapped as the caller needs.
 * `"batch"` events exist only with batch sequencing, so a FIFO app can't
 * listen for them.
 */
export type On<
  sequence extends SequencingConfig,
  mutationsConfig extends MutationsConfig,
  unsubscribe,
> = {
  (event: "mutation", cb: MutationListener<mutationsConfig>): unsubscribe;
  (event: "block", cb: BlockListener<sequence, mutationsConfig>): unsubscribe;
} & ([sequence] extends ["fifo"]
  ? unknown
  : (event: "batch", cb: BatchListener<mutationsConfig>) => unsubscribe);
