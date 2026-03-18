import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { formatEther } from "viem";

export function useAddressInfo(address: Address | undefined, signedIn = false) {
  return useQuery({
    queryKey: ["addressInfo", address],
    enabled: signedIn && !!address,
    queryFn: async () => {
      const res = await fetch(`/api/fast/account?address=${address}`);
      if (!res.ok) throw new Error("Failed to fetch account");
      const data = (await res.json()) as { balance: string; nonce: number };
      return { balance: formatEther(BigInt(data.balance)), nonce: data.nonce };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
