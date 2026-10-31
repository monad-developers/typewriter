import { useMutation, useQueryClient } from "@tanstack/react-query";
import { incrementNonce } from "typewriter/client";
import type { Address } from "viem";
import { request } from "../lib/api";
import { useManifest } from "./useManifest";
import { signMutation } from "./useSign";
import { useStoredAccount } from "./useStoredAccount";

type DepositParams = {
  asset: Address;
  amount: bigint;
};

export function useDepositMutation() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deploymentKey;
  const { data: account } = useStoredAccount();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ asset, amount }: DepositParams) => {
      if (!account) throw new Error("No account");
      if (manifest === undefined) throw new Error("Missing manifest");

      const signed = await signMutation(account, manifest, "Deposit", {
        asset,
        amount,
      });
      const result = await request<{ executionIndex: bigint }>("/api", {
        method: "POST",
        body: signed,
      });

      return {
        executionIndex: result.executionIndex,
        account: { ...account, nonce: incrementNonce(account.nonce) },
      };
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(["storedAccount", storageKey], result.account);
      await queryClient.invalidateQueries({
        queryKey: ["balances", account?.accountId],
      });
    },
  });
}
