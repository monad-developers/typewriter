import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import type { ApiMutation } from "./useMutations";

export type ApiKey = {
  keyType: 0 | 1 | 2;
  permissions: number;
  expiry: number;
  publicKey: Hex;
};

export type ApiOrder = {
  quantity: string;
  instrumentId: number;
  price: string;
  tickVolume: number;
  side: 0 | 1;
};

export type ApiAccount = {
  address: Hex;
  serial: number;
  keys: ApiKey[];
  nonces: Record<string, string>;
  orders: ApiOrder[];
  balances: Record<Address, string>;
  mutations: ApiMutation[];
};

export function useAccount(idOrAddress: string | undefined) {
  return useQuery({
    queryKey: ["account", idOrAddress],
    queryFn: async () => {
      const res = await fetch(`/api/account/${idOrAddress}`);
      if (!res.ok)
        throw new Error(`Failed to fetch account ${idOrAddress}`);
      return (await res.json()) as ApiAccount;
    },
    enabled: !!idOrAddress,
  });
}
