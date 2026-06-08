import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { request } from "../lib/api";
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
      return request<ApiAccount>(`/api/account/${idOrAddress}`);
    },
    enabled: !!idOrAddress,
    refetchInterval: 1000,
  });
}
