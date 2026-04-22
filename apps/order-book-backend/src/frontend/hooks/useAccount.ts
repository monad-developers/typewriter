import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";

export type ApiKey = {
  keyType: 0 | 1 | 2;
  permissions: number;
  expiry: number;
  publicKey: Hex;
};

export type ApiAccount = {
  address: Hex;
  keys: ApiKey[];
};

export function useAccount(address: Hex | undefined) {
  return useQuery({
    queryKey: ["account", address],
    queryFn: async () => {
      const res = await fetch(`/api/account/${address}`);
      if (!res.ok) throw new Error(`Failed to fetch account ${address}`);
      return (await res.json()) as ApiAccount;
    },
    enabled: !!address,
  });
}
