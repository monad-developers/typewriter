import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseEther } from "viem";
import type { Address } from "viem";
import type { PostTransferRequest, PostTransferResponse } from "../api";
import { useAccountContext } from "../contexts/AccountContext";

type TransferParams = {
  to: Address;
  amount: number;
};

export function useTransfer() {
  const { account, addTx } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: TransferParams) => {
      if (!account) throw new Error("No account");

      const body: PostTransferRequest = { from: account.address, to, amount };

      const start = performance.now();
      const res = await fetch("/api/fast/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const submissionLatency = performance.now() - start;

      if (!res.ok) throw new Error(await res.text());

      const data = (await res.json()) as PostTransferResponse;

      addTx({
        hash: data.hash,
        status: "finalized",
        amount: parseEther(amount.toString()),
        to,
        cost: 0n,
        blockNumber: 0n,
        preflightLatency: 0,
        submissionLatency,
        timestamp: Date.now(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["addressInfo", account?.address],
      });
    },
    onError: (error) => {
      console.error(error);
    },
  });
}
