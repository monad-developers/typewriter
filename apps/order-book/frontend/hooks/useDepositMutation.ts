import { useMutation, useQueryClient } from "@tanstack/react-query";
import { incrementNonce } from "typewriter/client";
import type { Address } from "viem";
import { request } from "../lib/api";
import { useManifest } from "./useManifest";
import { signDeposit } from "./useSign";
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

      const signed = await signDeposit(account, manifest, account.nonce, {
        asset,
        amount,
      });

      const start = performance.now();
      const result = await request<{ executionIndex: bigint }>("/api", {
        method: "POST",
        body: signed,
      });
      console.log(
        `[tx-latency] deposit ${(performance.now() - start).toFixed(1)}ms`,
      );

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
