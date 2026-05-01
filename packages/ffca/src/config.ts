import type { Abi, Address } from "ox";
import type { AbiParameter, PrivateKeyAccount } from "viem";

export type FFCA = {
  state: Readonly<unknown>;
};

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
  abi: Abi.Abi;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  state: { initial: unknown };
  mutations: { [name: string]: FFCAMutationConfig };
  // sequencing
};

export function createFFCA(config: FFCAConfig): FFCA {
  const state = config.state.initial;

  // @ts-expect-error
  return { state };
}
