import { type Cause, Data } from "effect";
import type { Hex } from "ox";
import type { EvmError } from "typewriter-evm";
import { type Abi, decodeErrorResult } from "viem";
import type { MigrationError } from "./db-migrate";
import type { DbError } from "./db-transport";
import type { RpcError } from "./rpc";
import type { NoDataReturnedError } from "./rpc-request";
import type { ReceivedMutation } from "./typewriter-types";
import type { WatchError } from "./watch";

/** Revert data from revm, decoded against the app's ABI when it matches. */
export type Revert = {
  data: Hex.Hex;
  /** The custom error's name, or `Error`/`Panic` for the built-in ones. */
  errorName: string | undefined;
  args: readonly unknown[] | undefined;
};

export function decodeRevert(abi: Abi, data: Hex.Hex): Revert {
  try {
    const { errorName, args } = decodeErrorResult({ abi, data });
    return { data, errorName, args };
  } catch {
    // Empty revert data, or a selector that isn't in the ABI.
    return { data, errorName: undefined, args: undefined };
  }
}

/** `prefix`, and the decoded error with its arguments, like `Error("reason")`. */
export function revertMessage(prefix: string, revert: Revert) {
  if (revert.errorName === undefined) return prefix;
  const args = (revert.args ?? [])
    .map((arg) => (typeof arg === "string" ? JSON.stringify(arg) : String(arg)))
    .join(", ");
  return `${prefix} with ${revert.errorName}(${args})`;
}

/** `execute` got a mutation name that the app does not define. */
export class UnknownMutationError extends Data.TaggedError(
  "UnknownMutationError",
)<{
  mutation: string;
}> {
  override get message() {
    return `Unknown mutation '${this.mutation}'`;
  }
}

/** `execute` got params or an authorization that its mutation does not take. */
export class InvalidMutationError extends Data.TaggedError(
  "InvalidMutationError",
)<{
  mutation: string;
  cause: unknown;
}> {
  override get message() {
    return `Invalid '${this.mutation}' mutation`;
  }
}

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  mutation: ReceivedMutation;
  cause: unknown;
}> {
  override get message() {
    return `Failed to encode '${this.mutation.name}' mutation`;
  }
}

/** A mutation reverted when executed in revm. */
export class MutationRevertedError extends Data.TaggedError(
  "MutationRevertedError",
)<Revert> {
  override get message() {
    return revertMessage("Mutation reverted", this);
  }
}

/** A mutation halted when executed in revm, e.g. on an invalid opcode. */
export class MutationHaltedError extends Data.TaggedError(
  "MutationHaltedError",
)<{
  reason: string;
}> {
  override get message() {
    return `Mutation halted with ${this.reason}`;
  }
}

/** A mutation's authorization or credential expires before `minExpiration`. */
export class MutationExpiresTooSoonError extends Data.TaggedError(
  "MutationExpiresTooSoonError",
)<{
  expiration: bigint;
  minExpiration: bigint;
}> {
  override get message() {
    return `Mutation expires at ${this.expiration}, before ${this.minExpiration}`;
  }
}

/** A mutation takes more gas than a settlement can. */
export class MutationTooLargeError extends Data.TaggedError(
  "MutationTooLargeError",
)<{
  gas: number;
}> {
  override get message() {
    return `Mutation takes ${this.gas} gas, more than a settlement can`;
  }
}

export class SignTransactionError extends Data.TaggedError(
  "SignTransactionError",
)<{
  cause: unknown;
}> {
  override get message() {
    return "Failed to sign settlement transaction";
  }
}

/** Each part of the program runs forever, so it stops only on a bug. */
export class ProgramStoppedError extends Data.TaggedError(
  "ProgramStoppedError",
) {
  override get message() {
    return "Typewriter program stopped unexpectedly";
  }
}

/** A mutation that was enqueued onchain reverted when enqueued in revm. */
export class EnqueueRevertedError extends Data.TaggedError(
  "EnqueueRevertedError",
)<Revert> {
  override get message() {
    return revertMessage("Enqueued mutation reverted", this);
  }
}

/** A mutation that was enqueued onchain halted when enqueued in revm. */
export class EnqueueHaltedError extends Data.TaggedError("EnqueueHaltedError")<{
  reason: string;
}> {
  override get message() {
    return `Enqueued mutation halted with ${this.reason}`;
  }
}

/** An RPC provider serves a different chain than `config.chainId`. */
export class ChainIdMismatchError extends Data.TaggedError(
  "ChainIdMismatchError",
)<{
  origin: string;
  expected: number;
  actual: number;
}> {
  override get message() {
    return `RPC ${this.origin} serves chain ${this.actual}, but config.chainId is ${this.expected}`;
  }
}

/** The scheduler has pending transactions at startup, e.g. from a previous process. */
export class PendingTransactionsError extends Data.TaggedError(
  "PendingTransactionsError",
)<{
  address: Hex.Hex;
  latest: number;
  pending: number;
}> {
  override get message() {
    return `Account ${this.address} has ${this.pending - this.latest} pending transactions`;
  }
}

/** A settlement transaction was mined but reverted onchain. */
export class SettlementRevertedError extends Data.TaggedError(
  "SettlementRevertedError",
)<{
  transactionHash: Hex.Hex;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} reverted onchain`;
  }
}

/**
 * A settlement succeeded after an earlier one reverted. Each checks the
 * execution hash, so only an execution outside the runtime allows it.
 */
export class SettlementAfterRevertError extends Data.TaggedError(
  "SettlementAfterRevertError",
)<{
  transactionHash: Hex.Hex;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} succeeded after an earlier one reverted`;
  }
}

/**
 * After a resync, the chain's `executionHash` is not where the first reverted
 * settlement started, so something outside the runtime executed.
 */
export class ResyncMismatchError extends Data.TaggedError(
  "ResyncMismatchError",
)<{
  blockNumber: bigint;
  expected: Hex.Hex;
  actual: Hex.Hex;
}> {
  override get message() {
    return `At block ${this.blockNumber}, the execution hash is ${this.actual}, but the reverted settlements start at ${this.expected}`;
  }
}

/** A settlement did not land `blocks` blocks after it was first sent. */
export class SettlementStuckError extends Data.TaggedError(
  "SettlementStuckError",
)<{
  nonce: number;
  transactionHash: Hex.Hex;
  blocks: bigint;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} with nonce ${this.nonce} did not land ${this.blocks} blocks after it was sent`;
  }
}

/** A reorg replaced a block with settlements before it was final. */
export class SettlementReorgedError extends Data.TaggedError(
  "SettlementReorgedError",
)<{
  blockNumber: bigint;
  blockHash: Hex.Hex;
}> {
  override get message() {
    return `Settlements were reorged out of block ${this.blockNumber} (${this.blockHash})`;
  }
}

/** A reorg replaced a block with enqueues that revm replayed. */
export class EnqueueReorgedError extends Data.TaggedError(
  "EnqueueReorgedError",
)<{
  blockNumber: bigint;
  blockHash: Hex.Hex;
}> {
  override get message() {
    return `Block ${this.blockNumber} (${this.blockHash}) with enqueued mutations was reorged out`;
  }
}

/**
 * `program` stopped, so a waiting `execute` will never get an answer. `cause`
 * is how the program exited: a {@link ProgramError}, or an interruption.
 */
export class TypewriterStoppedError extends Data.TaggedError(
  "TypewriterStoppedError",
)<{
  cause: Cause.Cause<ProgramError>;
}> {
  override get message() {
    return "Typewriter stopped";
  }
}

export type ExecuteMutationError =
  | EncodeMutationError
  | EvmError
  | MutationRevertedError
  | MutationHaltedError
  | MutationExpiresTooSoonError
  | MutationTooLargeError;

/** Why `execute` did not accept a mutation. */
export type ExecuteError =
  | UnknownMutationError
  | InvalidMutationError
  | ExecuteMutationError
  | TypewriterStoppedError;

export type ProgramError =
  | WatchError
  | DbError
  | EvmError
  | SettlementRevertedError
  | SettlementAfterRevertError
  | ResyncMismatchError
  | SettlementReorgedError
  | SettlementStuckError
  | EnqueueRevertedError
  | EnqueueHaltedError
  | EnqueueReorgedError
  | SignTransactionError
  | ProgramStoppedError;

export type CreateTypewriterError =
  | DbError
  | RpcError
  | NoDataReturnedError
  | MigrationError
  | ChainIdMismatchError
  | PendingTransactionsError
  | EvmError;
