import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getNonce, useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { signMarketOrder } from "./useSign";

type MarketOrderParams = {
  instrumentId: number;
  side: "buy" | "sell";
  amount: string;
};

export function useMarketOrderMutation() {
  const { account, incrementSeq } = useAccountContext();
  const { domain } = useDomainContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ instrumentId, side, amount }: MarketOrderParams) => {
      if (!account) throw new Error("No account");
      if (domain === null) throw new Error("Missing domain");

      const signed = await signMarketOrder(account, domain, getNonce(account), {
        quantity: BigInt(amount),
        minReceivedQuantity: 0n,
        instrumentId,
        bidOrAsk: side === "buy" ? 0 : 1,
      });

      const start = performance.now();
      const result = await request("/api", {
        method: "POST",
        body: signed,
      });
      console.log(
        `[tx-latency] market-order ${(performance.now() - start).toFixed(1)}ms`,
      );

      return result;
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
