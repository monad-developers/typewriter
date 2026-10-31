import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { request } from "../lib/api";
import type { ApiMutation } from "./useMutations";

export type ApiKey = {
  keyType: 0 | 1 | 2;
  permissions: bigint;
  expiration: number;
  publicKey: Hex;
};

export type ApiAccount = {
  address: Hex;
  credentials: ApiKey[];
  balances: Record<Address, bigint>;
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
