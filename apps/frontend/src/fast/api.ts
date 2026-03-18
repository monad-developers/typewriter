import type { Address, Hash } from "viem";

/** GET /api/account?address=<Address> */
export type GetAccountResponse = {
  address: Address;
  balance: string;    // token balance, ether-formatted (e.g. "100.0")
  txCount: number;
};

/** POST /api/transfer */
export type PostTransferRequest = {
  from: Address;
  to: Address;
  amount: number;     // token amount in whole units
};

export type PostTransferResponse = {
  hash: Hash;
  submissionLatency: number;  // ms, measured server-side
};
