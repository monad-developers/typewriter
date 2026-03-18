import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, TOKEN_ADDRESS } from "../../constants";
import type { Transfer } from "../api";
import { useAccountContext } from "../contexts/AccountContext";

const EIP712_DOMAIN = {
  name: "FastTransfer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: TOKEN_ADDRESS,
} as const;

const EIP712_TYPES = {
  Transfer: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function useTransfer() {
  const { account, addTx, updateTx } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: Omit<Transfer<number>, "from">) => {
      if (!account) throw new Error("No account");

      const amountWei = parseEther(amount.toString());
      const cached = queryClient.getQueryData<{ balance: string; nonce: number }>(
        ["addressInfo", account.address],
      );
      const nonce = cached?.nonce ?? 0;
      const deadline = Math.floor(Date.now() / 1000) + 60;

      const signer = privateKeyToAccount(account.privateKey);
      const signature = await signer.signTypedData({
        domain: EIP712_DOMAIN,
        types: EIP712_TYPES,
        primaryType: "Transfer",
        message: {
          from: account.address,
          to,
          amount: amountWei,
          nonce: BigInt(nonce),
          deadline: BigInt(deadline),
        },
      });

      const body = {
        from: account.address,
        to,
        amount: amountWei.toString(),
        nonce,
        deadline,
        signature,
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
        amount: amountWei,
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
