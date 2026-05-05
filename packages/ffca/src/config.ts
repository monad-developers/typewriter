import type { Abi, Address } from "ox";
import type { AbiParameter, PrivateKeyAccount } from "viem";

// TODO(kyle) add encode/decode, db schema,
export type FFCAMutationConfig =
  | {
      params: readonly AbiParameter[];
      apply: (state: unknown, args: unknown) => void;
    }
  | {
      params: readonly AbiParameter[];
      resolution: readonly AbiParameter[];
      resolve: (state: unknown, args: unknown) => unknown;
      apply: (state: unknown, args: unknown, resolution: unknown) => void;
    };

export type FFCAConfig = {
  address: Address.Address;
  domain: { name: string; version: string };
  abi: Abi.Abi;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  state: { initial: unknown };
  mutations: { [name: string]: FFCAMutationConfig };
  // sequencing
  // account model
};
