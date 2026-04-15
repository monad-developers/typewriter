"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountOptions, getNonce, incrementSeq } from "~/lib/account";
import { API_URL } from "~/lib/constants";
import { signCloseOrder } from "~/lib/sign";

type CloseOrderParams = {
  orderId: number;
};

export function useCloseOrderMutation() {
  const { data: account } = useQuery(accountOptions);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orderId }: CloseOrderParams) => {
      if (!account) throw new Error("No account");

      const signed = await signCloseOrder(account, getNonce(account), {
        orderId,
      });

      const res = await fetch(`${API_URL}/api/close-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error?.split(":")[0] ?? "Cancel failed");
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
