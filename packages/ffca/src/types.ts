import type { AbiParameter } from "abitype";
import type { Hex } from "ox";
import type {
  AbiParametersToValue,
  MutationConfig,
  SignatureConfig,
} from "./config";
import type { InternalMutation } from "./internal";

type MutationParams<mutationConfig extends MutationConfig> =
  readonly AbiParameter[] extends mutationConfig["params"]
    ? unknown
    : AbiParametersToValue<mutationConfig["params"]>;

type SignatureValue<signatureConfig extends SignatureConfig> =
  readonly AbiParameter[] extends signatureConfig
    ? unknown
    : AbiParametersToValue<signatureConfig>;

export type FFCAMutation<
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = {
  name: name;
  params: MutationParams<mutationConfig>;
  signature: SignatureValue<signatureConfig>;
};

export type FFCAMutationInput<
  mutationsConfig extends Record<string, MutationConfig>,
  signatureConfig extends SignatureConfig,
  name extends keyof mutationsConfig & string = keyof mutationsConfig & string,
> = {
  [name in keyof mutationsConfig & string]: FFCAMutation<
    name,
    mutationsConfig[name],
    signatureConfig
  >;
}[name];

export type FFCAMutationResult = { id: number };

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
      signature: unknown;
      config: InternalMutation;
    }
  | ({
      status: "enqueued";
      id: number;
      name: string;
      params: unknown;
      signature: unknown;
      config: InternalMutation;
    } & Extract<ForceInclusion, { isForceInclusion: true }>)
  | ({
      status: "accepted";
      id: number;
      name: string;
      params: unknown;
      signature: unknown;
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
      signature: unknown;
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
      signature: unknown;
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
  signatureConfig extends SignatureConfig = SignatureConfig,
> = (event: MutationEventForConfig<mutationsConfig, signatureConfig>) => void;
export type BatchListener<
  mutationsConfig extends Record<string, MutationConfig> = Record<
    string,
    MutationConfig
  >,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = (event: BatchEventForConfig<mutationsConfig, signatureConfig>) => void;
export type BlockListener<
  sequence extends "fifo" | "batch",
  mutationsConfig extends Record<string, MutationConfig> = Record<
    string,
    MutationConfig
  >,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = (
  event: BlockEventForConfig<sequence, mutationsConfig, signatureConfig>,
) => void;

export type MutationEventForConfig<
  mutationsConfig extends Record<string, MutationConfig>,
  signatureConfig extends SignatureConfig,
  name extends keyof mutationsConfig & string = keyof mutationsConfig & string,
> = {
  [key in name]: MutationEvent<key, mutationsConfig[key], signatureConfig>;
}[name];

export type BatchEventForConfig<
  mutationsConfig extends Record<string, MutationConfig>,
  signatureConfig extends SignatureConfig,
> = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    MutationEventForConfig<mutationsConfig, signatureConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
  forceIncludedMutations?: Exclude<
    MutationEventForConfig<mutationsConfig, signatureConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type BlockEventForConfig<
  sequence extends "fifo" | "batch",
  mutationsConfig extends Record<string, MutationConfig>,
  signatureConfig extends SignatureConfig,
> = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
} & (sequence extends "fifo"
  ? {
      mutations: Exclude<
        MutationEventForConfig<mutationsConfig, signatureConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    }
  : {
      batches: Exclude<
        BatchEventForConfig<mutationsConfig, signatureConfig>,
        { status: "accepted" }
      >[];
      forceIncludedMutations: Exclude<
        MutationEventForConfig<mutationsConfig, signatureConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    });

export type MutationEvent<
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
> =
  | {
      status: "received";
      id: number;
      name: name;
      params: MutationParams<mutationConfig>;
      signature: SignatureValue<signatureConfig>;
    }
  | {
      status: "enqueued";
      id: number;
      name: name;
      params: MutationParams<mutationConfig>;
      signature: SignatureValue<signatureConfig>;
    }
  | {
      status: "accepted";
      id: number;
      name: name;
      params: MutationParams<mutationConfig>;
      signature: SignatureValue<signatureConfig>;
      isForceInclusion: boolean;
    }
  | {
      status: "included" | "safe" | "finalized";
      id: number;
      name: name;
      params: MutationParams<mutationConfig>;
      signature: SignatureValue<signatureConfig>;
      isForceInclusion: boolean;
    }
  | {
      status: "rejected";
      id: number;
      name: name;
      params: MutationParams<mutationConfig>;
      signature: SignatureValue<signatureConfig>;
      isForceInclusion: boolean;
      error: unknown;
    };

export type BatchEvent<
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    MutationEvent<name, mutationConfig, signatureConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
  forceIncludedMutations?: Exclude<
    MutationEvent<name, mutationConfig, signatureConfig>,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type BlockEvent<
  sequence extends "fifo" | "batch",
  name extends string = string,
  mutationConfig extends MutationConfig = MutationConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
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
        MutationEvent<name, mutationConfig, signatureConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    }
  : {
      batches: Exclude<
        BatchEvent<name, mutationConfig, signatureConfig>,
        { status: "accepted" }
      >[];
      forceIncludedMutations: Exclude<
        MutationEvent<name, mutationConfig, signatureConfig>,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    });
