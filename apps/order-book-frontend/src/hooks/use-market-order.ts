"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountOptions, getNonce, incrementSeq } from "~/lib/account";
import { API_URL } from "~/lib/constants";
import { signMarketOrder } from "~/lib/sign";

type MarketOrderParams = {
  instrumentId: number;
  side: "buy" | "sell";
  quantity: bigint;
  minReceivedQuantity?: bigint;
};

export function useMarketOrderMutation() {
  const { data: account } = useQuery(accountOptions);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      instrumentId,
      side,
      quantity,
      minReceivedQuantity = 0n,
    }: MarketOrderParams) => {
      if (!account) throw new Error("No account");

      const signed = await signMarketOrder(account, getNonce(account), {
        quantity,
        minReceivedQuantity,
        instrumentId,
        bidOrAsk: side === "buy" ? 0 : 1,
      });

      const res = await fetch(`${API_URL}/api/market-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error?.split(":")[0] ?? "Order failed");
      }

      return res.json();
    },
    onSuccess: async () => {
      incrementSeq();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["balances", account?.accountId],
        }),
        queryClient.invalidateQueries({ queryKey: ["orderbook"] }),
        queryClient.invalidateQueries({ queryKey: ["trades"] }),
        queryClient.invalidateQueries({
          queryKey: ["orders", account?.accountId],
        }),
      ]);
    },
  });
}
