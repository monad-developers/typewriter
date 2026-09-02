import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { ApiError, request } from "../lib/api";

type BalancesResponse = {
  account: Address;
  balances: Record<Address, string>;
};

export function useBalances(account: Address | undefined) {
  return useQuery({
    queryKey: ["balances", account],
    queryFn: async () => {
      const path = `/api/balances?account=${account}`;
      try {
        return await request<BalancesResponse>(path);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        return { account: account!, balances: {} } as BalancesResponse;
      }
    },
    enabled: !!account,
    refetchInterval: 2000,
  });
}
