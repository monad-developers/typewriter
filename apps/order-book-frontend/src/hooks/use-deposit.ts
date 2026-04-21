"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { accountOptions, getNonce, incrementSeq } from "~/lib/account";
import { API_URL } from "~/lib/constants";
import { signDeposit } from "~/lib/sign";

type DepositParams = {
  asset: Address;
  amount: bigint;
};

export function useDepositMutation() {
  const { data: account } = useQuery(accountOptions);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ asset, amount }: DepositParams) => {
      if (!account) throw new Error("No account");

      const signed = await signDeposit(account, getNonce(account), {
        asset,
        amount,
      });

      const res = await fetch(`${API_URL}/api/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error?.split(":")[0] ?? "Deposit failed");
      }

      return res.json() as Promise<{ id: number }>;
    },
    onSuccess: async () => {
      incrementSeq();
      await queryClient.invalidateQueries({
        queryKey: ["balances", account?.accountId],
      });
    },
  });
}
