import type { Hex } from "ox";
import type { FFCAMutationConfig } from "./config";

export type SubmittedMutation = {
  name: string;
  args: unknown;
  signature: unknown;
};

export type MutationStatus =
  | "submitted"
  | "enqueued"
  | "accepted"
  | "rejected"
  | "included"
  | "safe"
  | "finalized";

export type BundleStatus = "accepted" | "included" | "safe" | "finalized";
export type BlockStatus = "included" | "safe" | "finalized";

export type RuntimeMutation =
  | {
      status: "submitted";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      config: FFCAMutationConfig;
    }
  | {
      status: "enqueued";
      id: number;
      index: bigint;
      name: string;
      args: unknown;
      signature: unknown;
      config: FFCAMutationConfig;
      resolution?: unknown;
    }
  | {
      status: "accepted" | "included" | "safe" | "finalized";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      isForceInclusion: boolean;
      config: FFCAMutationConfig;
      resolution?: unknown;
    }
  | {
      status: "rejected";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      isForceInclusion: boolean;
      config: FFCAMutationConfig;
      error: unknown;
    };

export type MutationEvent =
  | {
      status: "submitted";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
    }
  | {
      status: "enqueued";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      resolution?: unknown;
    }
  | {
      status: "accepted" | "included" | "safe" | "finalized";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      isForceInclusion: boolean;
      resolution?: unknown;
    }
  | {
      status: "rejected";
      id: number;
      name: string;
      args: unknown;
      signature: unknown;
      isForceInclusion: boolean;
      error: unknown;
    };

export type ResolvedMutation = Extract<
  RuntimeMutation,
  { status: "enqueued" | "accepted" | "included" | "safe" | "finalized" }
>;

export type RuntimeBundle = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    RuntimeMutation,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type BundleEvent = {
  status: "accepted" | "included" | "safe" | "finalized";
  id: number;
  position: number;
  mutations: Exclude<
    MutationEvent,
    { status: "submitted" | "enqueued" | "rejected" }
  >[];
};

export type RuntimeBlock = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
  bundles: Exclude<RuntimeBundle, { status: "accepted" }>[];
  enqueues: Extract<RuntimeMutation, { status: "enqueued" }>[];
  forceExecutes: Extract<RuntimeMutation, { status: "enqueued" }>[];
};

export type BlockEvent = {
  status: BlockStatus;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  transactionHash: Hex.Hex;
  bundles: Exclude<BundleEvent, { status: "accepted" }>[];
  // enqueues: Extract<RuntimeMutation, { status: "enqueued" }>;
  // forceExecutes: Extract<RuntimeMutation, { status: "enqueued" }>;
};
