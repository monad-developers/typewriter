import type { Abi, Address } from "ox";
import type { PrivateKeyAccount } from "viem";

export type FFCAState = object;

export type FFCAStateConfig<state extends FFCAState> = {
  initial: state;
};

export type FFCAConfig<state extends FFCAState> = {
  address: Address.Address;
  abi: Abi.Abi;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  state: FFCAStateConfig<state>;
  // mutations
  // sequencing
};

export function createFFCAState<state extends FFCAState>(
  config: FFCAStateConfig<state>,
): FFCAStateConfig<state> {
  return config;
}

export type FFCA<state extends FFCAState> = {
  state: state;
};

export function createFFCA<state extends FFCAState>(
  config: FFCAConfig<state>,
): FFCA<state> {
  const state = config.state.initial;

  return {
    state,
  };
}
