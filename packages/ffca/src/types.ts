import type { Hex } from "ox";
import type { FFCAMutationConfig } from "./config";

// What a client posts to ffca.execute(). `signature` is a structured value
// matching `FFCAConfig.signature.params` — ffca ABI-encodes it into the
// contract's `bundle.signatures[]`. Must include `keyType` and
// `rawSignature` fields once the authorize hook lands.
export type SubmittedMutation = {
  name: string;
  args: unknown;
  signature: unknown;
};

export type MutationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";

export type BundleStatus = Exclude<MutationStatus, "pending" | "rejected">;
export type BlockStatus = BundleStatus;

// `config` is the resolved per-mutation entry from FFCAConfig.mutations,
// attached at execute() time. Note: it carries the user's apply/resolve
// function references — drop it before serializing events to a wire or DB.

// A mutation in the queue, before the bundle loop has touched it.
export type PendingMutation = SubmittedMutation & {
  id: number;
  status: "pending";
  config: FFCAMutationConfig;
};

// A mutation that failed apply (or was rejected upstream).
type RejectedMutation = SubmittedMutation & {
  id: number;
  status: "rejected";
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
        resolution?: unknown;
        config: FFCAMutationConfig;
      }
    : never
  : never;

export type MutationEvent =
  | PendingMutation
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
