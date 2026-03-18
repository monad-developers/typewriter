import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseEther } from "viem";
import type { Transfer } from "../api";
import { useAccountContext } from "../contexts/AccountContext";

export function useTransfer() {
  const { account, addTx } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: Omit<Transfer, "from">) => {
      if (!account) throw new Error("No account");

      const body = { from: account.address, to, amount: parseEther(amount.toString()).toString() };

      const start = performance.now();
      const res = await fetch("/api/fast/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const submissionLatency = performance.now() - start;

      if (!res.ok) throw new Error(await res.text());

      addTx({
        hash: "0x",
        status: "accepted",
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
