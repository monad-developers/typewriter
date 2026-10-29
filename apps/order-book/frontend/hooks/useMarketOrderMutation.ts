import { useMutation, useQueryClient } from "@tanstack/react-query";
import { incrementNonce } from "typewriter/client";
import { request } from "../lib/api";
import { useManifest } from "./useManifest";
import { signMarketOrder } from "./useSign";
import { useStoredAccount } from "./useStoredAccount";

type MarketOrderParams = {
  instrumentId: number;
  side: "buy" | "sell";
  amount: string;
};

export function useMarketOrderMutation() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deploymentKey;
  const { data: account } = useStoredAccount();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ instrumentId, side, amount }: MarketOrderParams) => {
      if (!account) throw new Error("No account");
      if (manifest === undefined) throw new Error("Missing manifest");

      const signed = await signMarketOrder(account, manifest, account.nonce, {
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

      return {
        result,
        account: { ...account, nonce: incrementNonce(account.nonce) },
      };
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(["storedAccount", storageKey], result.account);
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
