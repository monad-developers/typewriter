import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useAccountContext } from "../contexts/AccountContext";
import { signDeposit } from "./useSign";

type DepositParams = {
  asset: Address;
  amount: bigint;
};

export function useDepositMutation() {
  const { account } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ asset, amount }: DepositParams) => {
      if (!account) throw new Error("No account");

      const cached = queryClient.getQueryData<{ nonce: string }>([
        "balances",
        account.address,
      ]);
      const nonce = BigInt(cached?.nonce ?? "0");

      const signed = await signDeposit(account, nonce, { asset, amount });

      const res = await fetch("/api/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(err?.error ?? "Deposit failed");
      }

      return res.json() as Promise<{ id: number }>;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["balances", account?.address],
      });
      await queryClient.invalidateQueries({
        queryKey: ["instrument-price"],
      });
    },
    onError: (error) => {
      console.error(error);
    },
  });
}
