import type { AbiParameter } from "abitype";
import type { Hex } from "ox";
import type { AbiParametersToValue, MutationConfig } from "./config";
import type { InternalMutation } from "./internal";

export type KeyType = 0 | 1 | 2;

export type Credential = {
  readonly expiration: bigint;
  readonly keyType: KeyType;
  readonly permissions: bigint;
  readonly publicKey: Hex.Hex;
};

export type Authorization = {
  readonly accountID: Hex.Hex;
  readonly credentialID: bigint;
  readonly nonce: bigint;
  readonly expiration: bigint;
  readonly signature: Hex.Hex;
};

export type Account = {
  readonly nonces: Readonly<Record<`${bigint}`, bigint>>;
  readonly credentials: readonly Credential[];
  readonly activeCredentials: bigint;
};

export type CreateAccountParams = {
  readonly keyType: KeyType;
  readonly publicKey: Hex.Hex;
};

export type AddCredentialParams = {
  readonly expiration: bigint;
  readonly keyType: KeyType;
  readonly permissions: bigint;
  readonly publicKey: Hex.Hex;
};

export type RemoveCredentialParams = {
  readonly credentialID: bigint;
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

export type TypewriterMutationResult = { id: number };

export type MutationStatus =
  | "received"
  | "enqueued"
  | "accepted"
  | "rejected"
  | "included"
  | "safe"
  | "finalized";

export type BatchStatus = "accepted" | "included" | "safe" | "finalized";
export type BlockStatus = "included" | "safe" | "finalized";

type ForceInclusion =
  | {
      isForceInclusion: true;
      queueIndex: bigint;
    }
  | {
      isForceInclusion: false;
    };

export type RuntimeMutation =
  | {
      status: "received";
      id: number;
      name: string;
      params: unknown;
      authorization: Authorization;
      config: InternalMutation;
    }
  | ({
      status: "enqueued";
      id: number;
      name: string;
      params: unknown;
      authorization: Authorization;
      config: InternalMutation;
    } & Extract<ForceInclusion, { isForceInclusion: true }>)
  | ({
      status: "accepted";
      id: number;
      name: string;
      params: unknown;
      authorization: Authorization;
      journalId: number;
      isForceInclusion: boolean;
      config: InternalMutation;
      executionIndex?: bigint;
    } & ForceInclusion)
  | ({
      status: "included" | "safe" | "finalized";
      id: number;
      name: string;
      params: unknown;
      authorization: Authorization;
      journalId: number;
      isForceInclusion: boolean;
      config: InternalMutation;
      executionIndex?: bigint;
    } & ForceInclusion)
  | ({
      status: "rejected";
      id: number;
      name: string;
      params: unknown;
      authorization: Authorization;
      isForceInclusion: boolean;
      config: InternalMutation;
      error: unknown;
    } & ForceInclusion);

export type ReceivedMutation = Extract<RuntimeMutation, { status: "received" }>;
export type AcceptedMutation = Extract<RuntimeMutation, { status: "accepted" }>;
export type EnqueuedMutation = Extract<RuntimeMutation, { status: "enqueued" }>;
export type SubmittedMutation = Extract<
  RuntimeMutation,
  { status: "included" | "safe" | "finalized" }
>;
export type ExecutableMutation = Extract<
  RuntimeMutation,
  { status: "enqueued" | "accepted" | "included" | "safe" | "finalized" }
>;
export type RejectedMutation = Extract<RuntimeMutation, { status: "rejected" }>;

export type RuntimeEnqueue = {
  transactionHash: Hex.Hex;
  journalId: number;
  mutation: EnqueuedMutation | AcceptedMutation | SubmittedMutation;
};

export type RuntimeBatch = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: (AcceptedMutation | SubmittedMutation)[];
  // forceIncludedMutations: (AcceptedMutation | SubmittedMutation)[];
};

export type RuntimeBlock<sequence extends "fifo" | "batch"> = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
  // enqueues: Extract<RuntimeMutation, { status: "enqueued" }>[];
  // forceExecutes: Extract<RuntimeMutation, { status: "enqueued" }>[];
} & (sequence extends "fifo"
  ? {
      mutations: SubmittedMutation[];
    }
  : {
      batches: RuntimeBatch[];
      forceIncludedMutations: SubmittedMutation[];
    });

export type MutationListener<
  mutationsConfig extends Record<string, MutationConfig> = Record<
    string,
    MutationConfig
  >,
> = (event: MutationEventForConfig<mutationsConfig>) => void;
export type BatchListener<
  mutationsConfig extends Record<string, MutationConfig> = Record<
    string,
    MutationConfig
  >,
> = (event: BatchEventForConfig<mutationsConfig>) => void;
export type BlockListener<
  sequence extends "fifo" | "batch",
  mutationsConfig extends Record<string, MutationConfig> = Record<
    string,
    MutationConfig
  >,
> = (event: BlockEventForConfig<sequence, mutationsConfig>) => void;

export type MutationEventForConfig<
  mutationsConfig extends Record<string, MutationConfig>,
  name extends keyof mutationsConfig & string = keyof mutationsConfig & string,
> = {
  [key in name]: MutationEvent<key, mutationsConfig[key]>;
}[name];

export type BatchEventForConfig<
  mutationsConfig extends Record<string, MutationConfig>,
> = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    MutationEventForConfig<mutationsConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
  forceIncludedMutations?: Exclude<
    MutationEventForConfig<mutationsConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type BlockEventForConfig<
  sequence extends "fifo" | "batch",
  mutationsConfig extends Record<string, MutationConfig>,
> = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
} & (sequence extends "fifo"
  ? {
      mutations: Exclude<
        MutationEventForConfig<mutationsConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    }
  : {
      batches: Exclude<
        BatchEventForConfig<mutationsConfig>,
        { status: "accepted" }
      >[];
      forceIncludedMutations: Exclude<
        MutationEventForConfig<mutationsConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    });

export type MutationEvent<
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
> =
  | {
      status: "received";
      id: number;
      name: name;
      params: MutationParamsForName<name, mutationConfig>;
      authorization: Authorization;
    }
  | {
      status: "enqueued";
      id: number;
      name: name;
      params: MutationParamsForName<name, mutationConfig>;
      authorization: Authorization;
    }
  | {
      status: "accepted";
      id: number;
      name: name;
      params: MutationParamsForName<name, mutationConfig>;
      authorization: Authorization;
      isForceInclusion: boolean;
    }
  | {
      status: "included" | "safe" | "finalized";
      id: number;
      name: name;
      params: MutationParamsForName<name, mutationConfig>;
      authorization: Authorization;
      isForceInclusion: boolean;
    }
  | {
      status: "rejected";
      id: number;
      name: name;
      params: MutationParamsForName<name, mutationConfig>;
      authorization: Authorization;
      isForceInclusion: boolean;
      error: unknown;
    };

export type BatchEvent<
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
> = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    MutationEvent<name, mutationConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
  forceIncludedMutations?: Exclude<
    MutationEvent<name, mutationConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type BlockEvent<
  sequence extends "fifo" | "batch",
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
> = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
  // enqueues: Extract<RuntimeMutation, { status: "enqueued" }>;
  // forceExecutes: Extract<RuntimeMutation, { status: "enqueued" }>;
} & (sequence extends "fifo"
  ? {
      mutations: Exclude<
        MutationEvent<name, mutationConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    }
  : {
      batches: Exclude<
        BatchEvent<name, mutationConfig>,
        { status: "accepted" }
      >[];
      forceIncludedMutations: Exclude<
        MutationEvent<name, mutationConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    });
