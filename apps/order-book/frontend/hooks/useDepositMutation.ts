import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { getNonce, useAccountContext } from "../contexts/AccountContext";
import { signDeposit } from "./useSign";

type DepositParams = {
  asset: Address;
  amount: bigint;
};

export function useDepositMutation() {
  const { account, incrementSeq } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ asset, amount }: DepositParams) => {
      if (!account) throw new Error("No account");

      const signed = await signDeposit(account, getNonce(account), {
        asset,
        amount,
      });

      const start = performance.now();
      const res = await fetch("/api/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      console.log(
        `[tx-latency] deposit ${(performance.now() - start).toFixed(1)}ms`,
      );

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error ?? "Deposit failed");
      }

      return res.json() as Promise<{ id: number }>;
    },
    onSuccess: async () => {
      incrementSeq();
      await queryClient.invalidateQueries({
        queryKey: ["balances", account?.accountId],
      });
    },
    onError: (error) => {
      console.error(error);
    },
  });
}
