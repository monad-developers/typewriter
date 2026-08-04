import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext } from "react";
import { bytesToHex, type Hex } from "viem";
import {
  clearSessionKey,
  loadSessionKey,
  saveSessionKey,
} from "../lib/sessionKeyStore";
import { useDomainContext } from "./DomainContext";

export type Account = {
  accountId: Hex;
  keyId: number;
  /// A random nonce lane per session. Concurrent actions from one player never
  /// serialize behind each other, and two tabs cannot collide.
  nonceKey: bigint;
  seq: bigint;
  sessionKey: CryptoKeyPair;
};

export function nonceFor(account: Account, offset = 0n): bigint {
  return (account.nonceKey << 64n) | (account.seq + offset);
}

type AccountContextValue = {
  account: Account | null;
  loading: boolean;
  setAccount: (
    account: Pick<Account, "accountId" | "keyId" | "sessionKey"> | null,
  ) => Promise<void>;
  /// Reserves the next sequence number and returns the nonce to sign with.
  takeNonce: () => bigint;
};

const AccountContext = createContext<AccountContextValue | null>(null);

function randomNonceKey(): bigint {
  return BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24))));
}

async function loadAccount(storagePrefix: Hex): Promise<Account | null> {
  const accountId = localStorage.getItem(
    `${storagePrefix}:accountId`,
  ) as Hex | null;
  const keyId = localStorage.getItem(`${storagePrefix}:keyId`);
  const sessionKey = await loadSessionKey(storagePrefix);
  if (accountId === null || keyId === null || sessionKey === null) return null;

  return {
    accountId,
    keyId: Number(keyId),
    nonceKey: randomNonceKey(),
    seq: 0n,
    sessionKey,
  };
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { storagePrefix, loading: domainLoading } = useDomainContext();

  const { data: account = null, isLoading: loading } = useQuery({
    queryKey: ["account", storagePrefix],
    queryFn: () => loadAccount(storagePrefix!),
    enabled: storagePrefix !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const setAccount = useCallback(
    async (
      next: Pick<Account, "accountId" | "keyId" | "sessionKey"> | null,
    ) => {
      if (storagePrefix === null) throw new Error("Missing domain");
      let value: Account | null = null;
      if (next) {
        value = { ...next, nonceKey: randomNonceKey(), seq: 0n };
        localStorage.setItem(`${storagePrefix}:accountId`, value.accountId);
        localStorage.setItem(`${storagePrefix}:keyId`, String(value.keyId));
        await saveSessionKey(storagePrefix, value.sessionKey);
      } else {
        localStorage.removeItem(`${storagePrefix}:accountId`);
        localStorage.removeItem(`${storagePrefix}:keyId`);
        await clearSessionKey(storagePrefix);
      }
      queryClient.setQueryData(["account", storagePrefix], value);
    },
    [queryClient, storagePrefix],
  );

  // Reserving synchronously matters: a player can fire several paints inside one
  // animation frame, and each needs its own sequence number.
  const takeNonce = useCallback(() => {
    if (storagePrefix === null) throw new Error("Missing domain");
    const current = queryClient.getQueryData<Account | null>([
      "account",
      storagePrefix,
    ]);
    if (current == null) throw new Error("Not signed in");
    const nonce = nonceFor(current);
    queryClient.setQueryData<Account | null>(["account", storagePrefix], {
      ...current,
      seq: current.seq + 1n,
    });
    return nonce;
  }, [queryClient, storagePrefix]);

  return (
    <AccountContext.Provider
      value={{
        account,
        loading: domainLoading || loading,
        setAccount,
        takeNonce,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function useAccountContext() {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error("useAccountContext must be used within AccountProvider");
  }
  return ctx;
}
