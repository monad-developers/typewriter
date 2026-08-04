import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { useAccountContext } from "../contexts/AccountContext";
import { request } from "../lib/api";

export type AccountKey = {
  keyId: number;
  expiry: number;
  keyType: number;
  permissions: number;
  publicKey: Hex;
};

export type AccountState = {
  account: Hex;
  team: number;
  epoch: number;
  energy: number;
  maxEnergy: number;
  painted: number;
  keys: AccountKey[];
  mutations: Record<string, unknown>[];
};

/// Energy and team come from contract storage, so this refetches on a short
/// interval and after every accepted action.
export function useAccountState() {
  const { account } = useAccountContext();

  return useQuery({
    queryKey: ["accountState", account?.accountId],
    queryFn: () => request<AccountState>(`/api/account/${account!.accountId}`),
    enabled: account !== null,
    refetchInterval: 2000,
  });
}
