import { useQuery } from "@tanstack/react-query";

type BalancesResponse = {
  accountId: number;
  balances: { [assetId: number]: string };
};

export function useBalances(accountId: number) {
  return useQuery({
    queryKey: ["balances", accountId],
    queryFn: async () => {
      const res = await fetch(`/api/balances?accountId=${accountId}`);
      if (!res.ok) throw new Error("Failed to fetch balances");
      return (await res.json()) as BalancesResponse;
    },
    refetchInterval: 2000,
  });
}
