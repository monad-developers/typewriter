"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountOptions, getNonce, incrementSeq } from "~/lib/account";
import { API_URL } from "~/lib/constants";
import { signLimitOrder } from "~/lib/sign";

type LimitOrderParams = {
  instrumentId: number;
  side: "buy" | "sell";
  quantity: bigint;
  price: bigint;
};

export function useLimitOrderMutation() {
  const { data: account } = useQuery(accountOptions);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      instrumentId,
      side,
      quantity,
      price,
    }: LimitOrderParams) => {
      if (!account) throw new Error("No account");

      const signed = await signLimitOrder(account, getNonce(account), {
        quantity,
        instrumentId,
        price,
        bidOrAsk: side === "buy" ? 0 : 1,
      });

      const res = await fetch(`${API_URL}/api/limit-order`, {
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
        queryClient.invalidateQueries({
          queryKey: ["orders", account?.accountId],
        }),
      ]);
    },
  });
}
