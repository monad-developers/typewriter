import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Data } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Address } from "ox";
import type { EvmError } from "typewriter-evm";
import type { BlockNotFoundError, ContractFunctionRevertedError } from "viem";
import type { DeploymentLockError } from "./deployment-lock";
import type { MigrationError } from "./migrate";
import type { RpcConfigError, RpcRequestError } from "./rpc";
import type { EnqueuedMutation, ReceivedMutation } from "./types";

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export class UnknownMutationError extends Data.TaggedError(
  "UnknownMutationError",
)<{
  readonly mutationName: string;
}> {
  override get message() {
    return `unknown mutation: ${this.mutationName}`;
  }
}

export class ExecutionIndexError extends Data.TaggedError(
  "ExecutionIndexError",
)<{
  readonly address: Address.Address;
}> {
  override get message() {
    return `executionIndex() returned no data for ${this.address}`;
  }
}

export class SignTransactionError extends Data.TaggedError(
  "SignTransactionError",
)<{
  readonly cause: unknown;
}> {}

/** Failures from a drizzle query or the transaction wrapping it. */
export type DatabaseError = SqlError | EffectDrizzleQueryError;

/** Why a mutation was rejected before acceptance. */
export type MutationRejectionError =
  | EncodeMutationError
  | EvmError
  | ContractFunctionRevertedError;

export type ExecuteError = UnknownMutationError | MutationRejectionError;

/** A failure of the long-running runtime program; fatal to the Typewriter. */
export type RuntimeError =
  | DatabaseError
  | RpcRequestError
  | BlockNotFoundError
  | EvmError
  | MutationRejectionError
  | SignTransactionError;

/** A failure while starting the runtime, before the program is forked. */
export type StartupError =
  | DatabaseError
  | RpcConfigError
  | RpcRequestError
  | ExecutionIndexError
  | DeploymentLockError
  | MigrationError
  | EvmError;
