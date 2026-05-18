import type { Hex } from "ox";
import type { FFCAMutationConfig } from "./config";

// What a client posts to ffca.execute(). `signature` is a structured value
// matching `FFCAConfig.signature.params` — ffca ABI-encodes it into the
// contract's `bundle.signatures[]` and passes it to mutation callbacks.
export type SubmittedMutation = {
  name: string;
  args: unknown;
  signature: unknown;
};

export type MutationStatus =
  | "submitted"
  | "accepted"
  | "rejected"
  | "included"
  | "safe"
  | "finalized";

export type BundleStatus = Exclude<MutationStatus, "submitted" | "rejected">;
export type BlockStatus = BundleStatus;

// `config` is the resolved per-mutation entry from FFCAConfig.mutations,
// attached at execute() time. Note: it carries the user's apply/resolve
// function references — drop it before serializing events to a wire or DB.

// A mutation in the in-memory queue, before the bundle loop has touched it.
// Submitted mutations are not persisted.
export type SubmittedMutationEvent = SubmittedMutation & {
  id: number;
  status: "submitted";
  digest: Hex.Hex;
  config: FFCAMutationConfig;
};

// A mutation that failed apply (or was rejected upstream).
type RejectedMutation = SubmittedMutation & {
  id: number;
  status: "rejected";
  digest: Hex.Hex;
  error: unknown;
  config: FFCAMutationConfig;
};

// A mutation after resolve+apply have run. resolution is undefined for
// mutations without a `resolve` step. Distributed over BundleStatus so
// `Extract<MutationEvent, { status: "accepted" }>` narrows correctly.
export type ResolvedMutation = BundleStatus extends infer S
  ? S extends BundleStatus
    ? SubmittedMutation & {
        id: number;
        status: S;
        digest: Hex.Hex;
        resolution?: unknown;
        config: FFCAMutationConfig;
      }
    : never
  : never;

export type MutationEvent =
  | SubmittedMutationEvent
  | RejectedMutation
  | ResolvedMutation;

// Bundles only exist once their mutations are accepted, so the union starts
// at "accepted" rather than carrying a pre-bundle state. Chain anchor fields
// (number/hash/transactionHash) appear only once the submit step has run.
type AcceptedBundle = {
  id: number;
  status: "accepted";
  position: number;
  mutations: Extract<ResolvedMutation, { status: "accepted" }>[];
};

export type AnchoredBundle = {
  id: number;
  status: Exclude<BundleStatus, "accepted">;
  position: number;
  mutations: ResolvedMutation[];
  number: bigint;
  hash: Hex.Hex;
  transactionHash: Hex.Hex;
};

export type BundleEvent = AcceptedBundle | AnchoredBundle;

// A block bundles its bundles. "accepted" predates chain submission, so it has
// no on-chain identity yet.
type AcceptedBlock = {
  status: "accepted";
  bundles: AcceptedBundle[];
};

type AnchoredBlock = {
  status: Exclude<BlockStatus, "accepted">;
  number: bigint;
  hash: Hex.Hex;
  timestamp: bigint;
  bundles: AnchoredBundle[];
};

export type BlockEvent = AcceptedBlock | AnchoredBlock;
