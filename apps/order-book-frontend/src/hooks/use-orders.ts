"use client";

import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { API_URL } from "~/lib/constants";

export type Order = {
  orderIndex: number;
  instrumentId: number;
  quantity: string;
  price: string;
  side: number;
};

type OrdersResponse = {
  orders: Order[];
};

export function useOrders(account: Hex | undefined) {
  return useQuery({
    queryKey: ["orders", account],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/orders?account=${account}`);
      if (!res.ok) throw new Error("Failed to fetch orders");
      return (await res.json()) as OrdersResponse;
    },
    enabled: !!account,
    refetchInterval: 2000,
  });
}
