import { useQuery } from "@tanstack/react-query";
import { randomNonce } from "order-book-sdk";
import { loadStoredAccount, type StoredAccount } from "../lib/account-store";
import { useManifest } from "./useManifest";

export type Account = StoredAccount & { nonce: bigint };

export function toAccount(stored: StoredAccount): Account {
  return { ...stored, nonce: randomNonce() };
}

async function loadAccount(storageKey: string): Promise<Account | null> {
  const stored = await loadStoredAccount(storageKey);
  if (stored === null) return null;
  return toAccount(stored);
}

export function useStoredAccount() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deploymentKey;
  return useQuery({
    queryKey: ["storedAccount", storageKey],
    queryFn: () => loadAccount(storageKey!),
    enabled: storageKey !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
