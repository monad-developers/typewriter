import { useQuery } from "@tanstack/react-query";
import { packNonce } from "typewriter/client";
import { bytesToHex } from "viem";
import { loadStoredAccount, type StoredAccount } from "../lib/account-store";
import { useManifest } from "./useManifest";

export type Account = StoredAccount & { nonce: bigint };

function randomNonceLane(): bigint {
  return BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24))));
}

export function toAccount(stored: StoredAccount): Account {
  return { ...stored, nonce: packNonce(randomNonceLane(), 0n) };
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
