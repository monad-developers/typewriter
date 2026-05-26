import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getNonce, useAccountContext } from "../contexts/AccountContext";
import { signMarketOrder } from "./useSign";

type MarketOrderParams = {
  instrumentId: number;
  side: "buy" | "sell";
  amount: string;
};

export function useMarketOrderMutation() {
  const { account, incrementSeq } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ instrumentId, side, amount }: MarketOrderParams) => {
      if (!account) throw new Error("No account");

      const signed = await signMarketOrder(account, getNonce(account), {
        quantity: BigInt(amount),
        minReceivedQuantity: 0n,
        instrumentId,
        bidOrAsk: side === "buy" ? 0 : 1,
      });

      const start = performance.now();
      const res = await fetch("/api/market-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      console.log(
        `[tx-latency] market-order ${(performance.now() - start).toFixed(1)}ms`,
      );

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error ?? "Order failed");
      }

      return res.json();
    },
    onSuccess: async () => {
      incrementSeq();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["balances"] }),
        queryClient.invalidateQueries({ queryKey: ["price"] }),
        queryClient.invalidateQueries({ queryKey: ["depth"] }),
      ]);
    },
    onError: (error) => {
      console.error(error);
    },
  });
}
