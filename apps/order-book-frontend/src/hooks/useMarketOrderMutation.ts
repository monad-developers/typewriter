import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccountContext } from "../contexts/AccountContext";
import { signMarketOrder } from "./useSign";

type MarketOrderParams = {
  instrumentId: number;
  side: "buy" | "sell";
  amount: string;
  nonceOffset?: number;
};

export function useMarketOrderMutation() {
  const { account } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      instrumentId,
      side,
      amount,
      nonceOffset = 0,
    }: MarketOrderParams) => {
      if (!account) throw new Error("No account");

      const cached = queryClient.getQueryData<{ nonce: string }>([
        "balances",
        account.address,
      ]);
      const nonce = BigInt(cached?.nonce ?? "0") + BigInt(nonceOffset);

      const signed = await signMarketOrder(account, nonce, {
        quantity: BigInt(amount),
        minReceivedQuantity: 0n,
        instrumentId,
        bidOrAsk: side === "buy" ? 0 : 1,
      });

      const res = await fetch("/api/market-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(err?.error ?? "Order failed");
      }

      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["balances"] });
      await queryClient.invalidateQueries({ queryKey: ["instrument-price"] });
    },
    onError: (error) => {
      console.error(error);
    },
  });
}
