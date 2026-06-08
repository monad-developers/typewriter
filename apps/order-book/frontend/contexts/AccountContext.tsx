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
  nonceKey: bigint;
  seq: bigint;
  sessionKey: CryptoKeyPair;
};

export function getNonce(account: Account): bigint {
  return (account.nonceKey << 64n) | account.seq;
}

type AccountContextValue = {
  account: Account | null;
  loading: boolean;
  setAccount: (
    account: Pick<Account, "accountId" | "keyId" | "sessionKey"> | null,
  ) => Promise<void>;
  incrementSeq: () => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

async function clearStoredAccount(prefix: Hex): Promise<void> {
  localStorage.removeItem(`${prefix}:accountId`);
  localStorage.removeItem(`${prefix}:keyId`);
  await clearSessionKey(prefix);
}

function randomNonceKey(): bigint {
  return BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24))));
}

async function loadAccount(storagePrefix: Hex): Promise<Account | null> {
  const accountId = localStorage.getItem(
    `${storagePrefix}:accountId`,
  ) as Hex | null;
  const keyIdStr = localStorage.getItem(`${storagePrefix}:keyId`);
  const sessionKey = await loadSessionKey(storagePrefix);

  if (accountId === null || keyIdStr === null || sessionKey === null) {
    return null;
  }

  return {
    accountId,
    keyId: Number(keyIdStr),
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
      nextAccount: Pick<Account, "accountId" | "keyId" | "sessionKey"> | null,
    ) => {
      if (storagePrefix === null) throw new Error("Missing domain");
      let account: Account | null = null;
      if (nextAccount) {
        account = {
          ...nextAccount,
          nonceKey: randomNonceKey(),
          seq: 0n,
        };
        localStorage.setItem(`${storagePrefix}:accountId`, account.accountId);
        localStorage.setItem(`${storagePrefix}:keyId`, String(account.keyId));
        await saveSessionKey(storagePrefix, account.sessionKey);
      } else {
        await clearStoredAccount(storagePrefix);
      }
      queryClient.setQueryData(["account", storagePrefix], account);
    },
    [queryClient, storagePrefix],
  );

  const incrementSeq = useCallback(() => {
    if (storagePrefix === null) return;
    queryClient.setQueryData<Account | null>(
      ["account", storagePrefix],
      (account) => {
        return account == null
          ? account
          : { ...account, seq: account.seq + 1n };
      },
    );
  }, [queryClient, storagePrefix]);

  return (
    <AccountContext.Provider
      value={{
        account,
        loading: domainLoading || loading,
        setAccount,
        incrementSeq,
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
