import type { Hex } from "ox";

// What a client posts to ffca.execute(). The signature blob is key-type-
// polymorphic for now (matches order-book-backend); the dispatch lives in the
// future state-dependent verifier.
export type SubmittedMutation = {
  name: string;
  args: unknown;
  signature: Hex.Hex;
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

// A mutation in the queue, before the bundle loop has touched it.
type PendingMutation = SubmittedMutation & {
  id: number;
  status: "pending";
};

// A mutation that failed apply (or was rejected upstream).
type RejectedMutation = SubmittedMutation & {
  id: number;
  status: "rejected";
  error: unknown;
};

// A mutation after resolve+apply have run. resolution is undefined for
// mutations without a `resolve` step. Distributed over BundleStatus so
// `Extract<MutationEvent, { status: "accepted" }>` narrows correctly.
type ResolvedMutation = BundleStatus extends infer S
  ? S extends BundleStatus
    ? SubmittedMutation & { id: number; status: S; resolution?: unknown }
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

type AnchoredBundle = {
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
