"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { API_URL } from "~/lib/constants";

type BalancesResponse = {
  account: Address;
  nonce: string;
  balances: Record<Address, string>;
};

export function useBalances(account: Hex | undefined) {
  return useQuery({
    queryKey: ["balances", account],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/balances?account=${account}`);
      if (!res.ok) throw new Error("Failed to fetch balances");
      return (await res.json()) as BalancesResponse;
    },
    enabled: !!account,
    refetchInterval: 2000,
  });
}
