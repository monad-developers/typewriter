// Wire types — one-to-one with src/main.rs.
//
// Snake-case for payload fields, camelCase for the request method
// discriminator (matches `#[serde(tag = "method", rename_all = "camelCase")]`
// on the Rust Request enum).

import type { Address, Hex } from "ox";

export type Spec = "MonadEight" | "MonadNine" | "MonadNext";

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

export type ExecuteResult = {
  success: boolean;
  gas_used: number;
  gas_limit: number;
  output: Hex.Hex;
  access_list: { address: Address.Address; storageKeys: Hex.Hex[] }[];
  revert_data?: Hex.Hex;
};

export type ReadStorageParams = {
  address: Address.Address;
  slots: Hex.Hex[];
};

export type ReadStorageResult = { [slot: Hex.Hex]: Hex.Hex };

export type RevertJournalsParams = {
  count: number;
};

export type PruneJournalsParams = {
  count: number;
};

export type Request =
  | { method: "init"; id: number; params: InitParams }
  | { method: "setBlockContext"; id: number; params: BlockParams }
  | { method: "beginJournal"; id: number }
  | { method: "execute"; id: number; params: ExecuteParams }
  | { method: "simulate"; id: number; params: ExecuteParams }
  | { method: "readStorage"; id: number; params: ReadStorageParams }
  | { method: "commitJournal"; id: number }
  | { method: "revertJournal"; id: number }
  | { method: "revertJournals"; id: number; params: RevertJournalsParams }
  | { method: "pruneJournals"; id: number; params: PruneJournalsParams };

export type Response<T = unknown> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string };
