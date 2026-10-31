import { useMutation, useQueryClient } from "@tanstack/react-query";
import { bidOrAsk, type Side } from "order-book-sdk";
import { incrementNonce } from "typewriter/client";
import { request } from "../lib/api";
import { useManifest } from "./useManifest";
import { signMutation } from "./useSign";
import { useStoredAccount } from "./useStoredAccount";

type MarketOrderParams = {
  instrumentId: number;
  side: Side;
  quantity: bigint;
};

export function useMarketOrderMutation() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deploymentKey;
  const { data: account } = useStoredAccount();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ instrumentId, side, quantity }: MarketOrderParams) => {
      if (!account) throw new Error("No account");
      if (manifest === undefined) throw new Error("Missing manifest");

      const signed = await signMutation(account, manifest, "MarketOrder", {
        quantity,
        minReceivedQuantity: 0n,
        instrumentId: BigInt(instrumentId),
        bidOrAsk: bidOrAsk(side),
      });
      const result = await request("/api", {
        method: "POST",
        body: signed,
      });

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
