import type { AbiParameter } from "abitype";
import type { Hex } from "ox";
import type {
  AbiParametersToValue,
  MutationConfig,
  MutationsConfig,
  ResolvedTypewriterMutationConfig,
  SequencingConfig,
} from "./config";
import type { ExecuteMutationError } from "./typewriter";
import type { KeyType } from "./typewriter-constants";

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

type MutationParams<mutationConfig extends MutationConfig> =
  readonly AbiParameter[] extends mutationConfig["params"]
    ? unknown
    : AbiParametersToValue<mutationConfig["params"]>;

type MutationParamsForName<
  name extends string,
  mutationConfig extends MutationConfig,
> = name extends "CreateAccount"
  ? CreateAccountParams
  : name extends "AddCredential"
    ? AddCredentialParams
    : name extends "RemoveCredential"
      ? RemoveCredentialParams
      : MutationParams<mutationConfig>;

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
  [name in keyof mutationsConfig & string]: TypewriterMutation<
    name,
    mutationsConfig[name]
  >;
}[name];

export type TypewriterMutationResult = { executionIndex: bigint };

export type MutationStatus =
  | "received"
  | "enqueued"
  | "accepted"
  | "rejected"
  | "included"
  | "finalized";

export type BatchStatus = "accepted" | "included" | "finalized";
export type BlockStatus = "included" | "finalized";

type MutationBase = {
  name: string;
  /** Decoded from `mutationData`. */
  params: unknown;
  /** Decoded from `authorizationData`. */
  authorization: Authorization;
  config: ResolvedTypewriterMutationConfig;
  /**
   * The bytes the contract decodes `params` from, and the signature covers.
   * The runtime passes them to the contract as they are, never re-encoded.
   */
  mutationData: Hex.Hex;
  /** The bytes the contract decodes `authorization` from. */
  authorizationData: Hex.Hex;
};

// TODO(kyle) persist `isForceInclusion` and `queueIndex`, the mutation tables
// cannot tell a force-included row from a batched one.
type ForceInclusion =
  | { isForceInclusion: true; queueIndex: bigint }
  | { isForceInclusion: false };

/** Set when the mutation executes against the speculative state. */
type Execution = {
  /** The `execution_index` primary key of the mutation's row. */
  executionIndex: bigint;
  /** The EVM journal that holds the mutation's writes. */
  journalId: number;
};

/** Mirrors the `block_*` and `transaction_*` columns of a mutation row. */
export type Inclusion = {
  blockNumber: bigint;
  blockHash: Hex.Hex;
  blockTimestamp: bigint;
  transactionHash: Hex.Hex;
  transactionIndex: number;
};

export type ReceivedMutation = MutationBase & { status: "received" };
export type EnqueuedMutation = MutationBase & {
  status: "enqueued";
  isForceInclusion: true;
  queueIndex: bigint;
};
export type AcceptedMutation = MutationBase &
  ForceInclusion &
  Execution & { status: "accepted" };
export type IncludedMutation = MutationBase &
  ForceInclusion &
  Execution &
  Inclusion & { status: "included" | "finalized" };
export type RejectedMutation = MutationBase &
  ForceInclusion & { status: "rejected"; error: ExecuteMutationError };

export type RuntimeMutation =
  | ReceivedMutation
  | EnqueuedMutation
  | AcceptedMutation
  | IncludedMutation
  | RejectedMutation;

export type RuntimeBatch = {
  status: BatchStatus;
  id: number;
  position: number;
  mutations: (AcceptedMutation | IncludedMutation)[];
};

export type RuntimeBlock<sequence extends SequencingConfig> = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
} & (sequence extends "fifo"
  ? { mutations: IncludedMutation[] }
  : { batches: RuntimeBatch[]; forceIncludedMutations: IncludedMutation[] });

/** Fields of a runtime mutation that listeners never see. */
type RuntimeOnlyField =
  | "config"
  | "journalId"
  | "mutationData"
  | "authorizationData";

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
> = { id: number; position: number } & (
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
  transactionHash: Hex.Hex;
} & (sequence extends "fifo"
  ? { mutations: IncludedMutationEvent<mutationsConfig>[] }
  : {
      batches: Extract<
        BatchEvent<mutationsConfig>,
        { status: "included" | "finalized" }
      >[];
      forceIncludedMutations: IncludedMutationEvent<mutationsConfig>[];
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
