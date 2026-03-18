import type { Address } from "viem";

export type State<quantity = string> = {
  totalSupply: quantity;
  accounts: {
    [address: Address]: {
      balance: quantity;
      /** Alias for transaction count */
      nonce: number;
    };
  };
};

export type Transfer<quantity = string> = {
  from: Address;
  to: Address;
  amount: quantity;
};
