import { useQuery } from "@tanstack/react-query";
import { ANVIL_ACCOUNTS, TOKEN_ABI, TOKEN_ADDRESS } from "../constants";
import { publicClient } from "../lib/client";

export function useAvailableAccounts() {
  return useQuery({
    queryKey: ["availableAccounts"],
    queryFn: async () => {
      const balances = await Promise.all(
        ANVIL_ACCOUNTS.map((a) =>
          publicClient.readContract({
            address: TOKEN_ADDRESS,
            abi: TOKEN_ABI,
            functionName: "balanceOf",
            args: [a.address],
          }),
        ),
      );
      return ANVIL_ACCOUNTS.filter((_, i) => balances[i] === 0n);
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
