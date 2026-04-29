import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

type BalancesResponse = {
  account: Address;
  nonce: string;
  balances: Record<Address, string>;
};

export function useBalances(account: Address | undefined) {
  return useQuery({
    queryKey: ["balances", account],
    queryFn: async () => {
      const res = await fetch(`/api/balances?account=${account}`);
      if (res.status === 404)
        return { account: account!, balances: {} } as BalancesResponse;
      if (!res.ok) throw new Error("Failed to fetch balances");
      return (await res.json()) as BalancesResponse;
    },
    enabled: !!account,
    refetchInterval: 2000,
  });
}
