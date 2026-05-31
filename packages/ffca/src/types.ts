import type { AbiParameter, AbiParametersToPrimitiveTypes } from "abitype";
import type { Hex } from "ox";
import type {
  FFCAMutationConfig,
  MutationConfig,
  SignatureConfig,
} from "./config";

export type FFCAMutation<
  name extends string,
  mutationConfig extends MutationConfig,
  signatureConfig extends SignatureConfig,
> = {
  name: name;
  params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
  signature: AbiParametersToPrimitiveTypes<signatureConfig>;
};

export type FFCAMutationResult<mutationConfig extends MutationConfig> =
  mutationConfig extends { resolution: readonly AbiParameter[] }
    ? {
        id: number;
        resolution: AbiParametersToPrimitiveTypes<mutationConfig["resolution"]>;
      }
    : { id: number };

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
      args: unknown;
      signature: unknown;
      config: FFCAMutationConfig;
    }
  | ({
      status: "enqueued";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      config: FFCAMutationConfig;
      resolution?: unknown;
    } & Extract<ForceInclusion, { isForceInclusion: true }>)
  | ({
      status: "accepted";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      journalId: number;
      isForceInclusion: boolean;
      config: FFCAMutationConfig;
      resolution?: unknown;
    } & ForceInclusion)
  | ({
      status: "included" | "safe" | "finalized";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      journalId: number;
      isForceInclusion: boolean;
      config: FFCAMutationConfig;
      resolution?: unknown;
    } & ForceInclusion)
  | ({
      status: "rejected";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      isForceInclusion: boolean;
      config: FFCAMutationConfig;
      error: unknown;
    } & ForceInclusion);

export type ReceivedMutation = Extract<RuntimeMutation, { status: "received" }>;
export type AcceptedMutation = Extract<RuntimeMutation, { status: "accepted" }>;
export type EnqueuedMutation = Extract<RuntimeMutation, { status: "enqueued" }>;
export type SubmittedMutation = Extract<
  RuntimeMutation,
  { status: "included" | "safe" | "finalized" }
>;
export type MutationWithResolution = Extract<
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

  export type MutationListener = (event: MutationEvent) => void;
  export type BatchListener = (event: BatchEvent) => void;
  export type BlockListener<sequence extends "fifo" | "batch"> = (
    event: BlockEvent<sequence>,
  ) => void;

export type MutationEvent<
  name extends string,
  mutationConfig extends MutationConfig,
  signatureConfig extends SignatureConfig,
> =
  | {
      status: "received";
      id: number;
      name: name;
      params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
      signature: AbiParametersToPrimitiveTypes<signatureConfig>;
    }
  | {
      status: "enqueued";
      id: number;
      name: name;
      params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
      signature: AbiParametersToPrimitiveTypes<signatureConfig>;
      resolution?: unknown;
    }
  | {
      status: "accepted";
      id: number;
      name: name;
      params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
      signature: AbiParametersToPrimitiveTypes<signatureConfig>;
      journalId: number;
      isForceInclusion: boolean;
      resolution?: unknown;
    }
  | {
      status: "included" | "safe" | "finalized";
      id: number;
      name: name;
      params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
      signature: AbiParametersToPrimitiveTypes<signatureConfig>;
      journalId: number;
      isForceInclusion: boolean;
      resolution?: unknown;
    }
  | {
      status: "rejected";
      id: number;
      name: name;
      params: AbiParametersToPrimitiveTypes<mutationConfig["params"]>;
      signature: AbiParametersToPrimitiveTypes<signatureConfig>;
      isForceInclusion: boolean;
      error: unknown;
    };

export type BatchEvent<
> = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    MutationEvent,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
  forceIncludedMutations?: Exclude<
    MutationEvent,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type BlockEvent<sequence extends "fifo" | "batch"> = {
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
        MutationEvent,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    }
  : {
      batches: Exclude<BatchEvent, { status: "accepted" }>[];
      forceIncludedMutations: Exclude<
        MutationEvent,
        { status: "submitted" | "enqueued" | "rejected" }
      >[];
    });
