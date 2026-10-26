// Wire types — one-to-one with src/harness.rs.
//
// Snake-case for payload fields, camelCase for the request method
// discriminator (matches `#[serde(tag = "method", rename_all = "camelCase")]`
// on the Rust Request enum).

import type { Address, Hex } from "ox";

export type Spec = "MonadEight" | "MonadNine" | "MonadTen" | "MonadNext";

export type BlockParams = {
  number?: Hex.Hex;
  timestamp?: Hex.Hex;
  basefee?: Hex.Hex;
  coinbase?: Address.Address;
};

export type AccountParams = {
  balance?: Hex.Hex;
  nonce?: number;
  code?: Hex.Hex;
  storage?: { [slot: Hex.Hex]: Hex.Hex };
};

export type InitParams = {
  spec?: Spec;
  chain_id?: number;
  block?: BlockParams;
  accounts?: { [address: Address.Address]: AccountParams };
};

export type ExecuteParams = {
  from: Address.Address;
  to: Address.Address;
  data: Hex.Hex;
  value?: Hex.Hex;
};

export type SimulateParams = ExecuteParams & {
  journal_ids: number[];
};

type TxResult = {
  gas_used: number;
  access_list: { address: Address.Address; storageKeys: Hex.Hex[] }[];
};

type Revert = { status: "revert"; data: Hex.Hex };
// A failure other than REVERT, such as out of gas or an invalid opcode.
type Halt = { status: "halt"; reason: string };

export type ExecuteResult = TxResult & {
  // Writes to the called contract.
  slot_writes: { slot: Hex.Hex; value: Hex.Hex }[];
  // The 64-byte KECCAK256 inputs: a mapping key and the mapping's slot.
  keccak_preimages: Hex.Hex[];
} & ({ status: "success"; journal_id: number } | Revert | Halt);

// gas_used is the gas with the access list warm, as the chain charges it.
// gas_limit is gas_used plus a reserve for the SSTORE sentry and the 1/64
// that each call keeps, so the call takes the same path as at max gas. It
// assumes no nested call halts and is caught (see harness.rs).
export type SimulateResult = TxResult & {
  gas_limit: number;
} & ({ status: "success" } | Revert | Halt);

export type ReadStorageParams = {
  address: Address.Address;
  slots: Hex.Hex[];
};

export type ReadStorageResult = { [slot: Hex.Hex]: Hex.Hex };

export type JournalIdsParams = {
  journal_ids: number[];
};

export type Request =
  | { method: "setBlockContext"; id: number; params: BlockParams }
  | { method: "execute"; id: number; params: ExecuteParams }
  | { method: "simulate"; id: number; params: SimulateParams }
  | { method: "readStorage"; id: number; params: ReadStorageParams }
  | { method: "revertJournals"; id: number; params: JournalIdsParams }
  | { method: "pruneJournals"; id: number; params: JournalIdsParams };

export type Response<T = unknown> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string };
