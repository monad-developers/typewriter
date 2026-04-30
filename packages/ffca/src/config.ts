import type { Abi, Address } from "ox";
import type { PrivateKeyAccount } from "viem";

export type FFCAConfig = {
  address: Address.Address;
  abi: Abi.Abi;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  // state
  // mutations
  // sequencing
};

export type FFCA = {};

export function createFFCA(config: FFCAConfig): FFCA {
  return;
}
