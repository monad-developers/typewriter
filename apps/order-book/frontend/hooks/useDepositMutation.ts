import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { getNonce, useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { signDeposit } from "./useSign";

type DepositParams = {
  asset: Address;
  amount: bigint;
};

export function useDepositMutation() {
  const { account, incrementSeq } = useAccountContext();
  const { domain } = useDomainContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ asset, amount }: DepositParams) => {
      if (!account) throw new Error("No account");
      if (domain === null) throw new Error("Missing domain");

      const signed = await signDeposit(account, domain, getNonce(account), {
        asset,
        amount,
      });

      const start = performance.now();
      const result = await request<{ id: number }>("/api", {
        method: "POST",
        body: signed,
      });
      console.log(
        `[tx-latency] deposit ${(performance.now() - start).toFixed(1)}ms`,
      );

      return result;
    },
    onSuccess: async () => {
      incrementSeq();
      await queryClient.invalidateQueries({
        queryKey: ["balances", account?.accountId],
      });
    },
  });
}
