import type { Hex } from "ox";
import type {
  BatchEvent,
  BlockEvent,
  MutationEvent,
} from "../src/typewriter-types";
import type { Mutation } from "./assessment";
import type { AssessmentMutations } from "./assessment-constants";

/**
 * The key of a mutation in the events: its account and nonce. Every mutation
 * of a run has its own.
 */
export function mutationKey(authorization: {
  accountID: unknown;
  nonce: unknown;
}): string {
  return `${String(authorization.accountID).toLowerCase()}:${String(authorization.nonce)}`;
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
  mutation: Mutation;
  expected: Expected;
  resubmitted: boolean;
  /** What `execute` returned: for the submission, then for its resubmission. */
  results: Result[];
  /** The `enqueue` transaction. */
  transactionHash: Hex.Hex | undefined;
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
  expiration: number;
  /**
   * The seconds before the latest block that the authorization must expire
   * by: `0` for `AuthorizationExpired`, and `EXPIRATION_MARGIN` for
   * `MutationExpiresTooSoonError`.
   */
  margin: number;
  latestTimestamp: number;
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

/** Freezes `value` and everything it holds, so the runtime cannot change what the client sent. */
export function deepFreeze<value>(value: value): value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
