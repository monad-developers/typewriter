import type { Hex } from "ox";
import type {
  BatchEvent,
  BlockEvent,
  MutationEvent,
} from "../src/typewriter-types";
import type { Mutation } from "./assessment";
import type { AssessmentMutations } from "./assessment-constants";

/**
 * The key of a mutation in the events: its account, nonce and signature.
 * Every mutation of a run has its own, malformed or not, and a replacement
 * with the same nonce has another.
 */
export function mutationKey(authorization: {
  accountID: unknown;
  nonce: unknown;
  signature: unknown;
}): string {
  return `${String(authorization.accountID).toLowerCase()}:${String(authorization.nonce)}:${String(authorization.signature).toLowerCase()}`;
}

/** The name of a rejection: a revert's error name, or the error's tag. */
export function errorName(error: { _tag: string; errorName?: string }): string {
  return error._tag === "MutationRevertedError"
    ? (error.errorName ?? error._tag)
    : error._tag;
}

/** How a submission must end. Validation checks the run and the chain against it. */
export type Expected = {
  /** It executes, unless it is rejected with one of `errors`. */
  executes: boolean;
  /** The errors it may be rejected with. */
  errors: string[];
  /** The errors its resubmission may be rejected with. */
  resubmissionErrors: string[];
  /** The runtime reports it in mutation events. */
  events: boolean;
};

/**
 * What `execute` returned: an execution index, or an error's name. A revert
 * is named by its error, such as `InvalidNonce`.
 */
export type Result = { executionIndex: bigint } | { error: string };

/** One mutation the client submitted. */
export type Submission = {
  label: string;
  key: string;
  via: "execute" | "enqueue";
  /** The well-formed mutation, signed: what executes if anything does. */
  mutation: Mutation;
  /** What the client sent: the `execute` input, or the `enqueue` calldata. */
  sent: unknown;
  expected: Expected;
  resubmitted: boolean;
  /** What `execute` returned: for the submission, then for its resubmission. */
  results: Result[];
  /** The `enqueue` transaction. */
  transactionHash: Hex.Hex | undefined;
  /** The key of the submission whose nonce this enqueue takes. */
  replaces: string | undefined;
};

/** A reorg the harness made. */
export type Reorg = {
  /** The hashes of the blocks it replaced. */
  replaced: Hex.Hex[];
  timestamp: number;
};

/** The chain's latest block right after the runtime rejected a mutation as expired. */
export type ExpiryCheck = {
  key: string;
  expiration: bigint;
  /**
   * The seconds before the latest block that the authorization must expire
   * by: `0` for `AuthorizationExpired`, and `EXPIRATION_MARGIN` for
   * `MutationExpiresTooSoonError`.
   */
  margin: bigint;
  latestTimestamp: bigint;
};

/** Everything the run recorded, for validation against the chain. */
export type Run = {
  /** In submission order. */
  submissions: Submission[];
  mutationEvents: MutationEvent<AssessmentMutations>[];
  /** Emitted only with batch sequencing. */
  batchEvents: BatchEvent<AssessmentMutations>[];
  blockEvents: BlockEvent<"fifo" | "batch", AssessmentMutations>[];
  reorgs: Reorg[];
  expiryChecks: ExpiryCheck[];
};

export function makeRun(): Run {
  return {
    submissions: [],
    mutationEvents: [],
    batchEvents: [],
    blockEvents: [],
    reorgs: [],
    expiryChecks: [],
  };
}
