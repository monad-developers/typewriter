import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseEther } from "viem";
import type { Transfer } from "../api";
import { useAccountContext } from "../contexts/AccountContext";

export function useTransfer() {
  const { account, addTx, updateTx } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: Omit<Transfer<number>, "from">) => {
      if (!account) throw new Error("No account");

      const body = {
        from: account.address,
        to,
        amount: parseEther(amount.toString()).toString(),
      };

      const start = performance.now();
      const res = await fetch("/api/fast/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const submissionLatency = performance.now() - start;

      if (!res.ok) throw new Error(await res.text());

      const { id } = (await res.json()) as { id: string };

      addTx({
        hash: `0x${id}`,
        status: "accepted",
        amount: parseEther(amount.toString()),
        to,
        cost: 0n,
        blockNumber: 0n,
        preflightLatency: 0,
        submissionLatency,
        timestamp: Date.now(),
      });

      const es = new EventSource(`/api/fast/transfer/${id}/status`);
      es.onmessage = (e) => {
        const { status } = JSON.parse(e.data);
        updateTx(`0x${id}`, { status });
        if (status === "verified") {
          es.close();
          queryClient.invalidateQueries({
            queryKey: ["addressInfo", account.address],
          });
        }
      };
      es.onerror = () => es.close();
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
