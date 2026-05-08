import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext } from "react";
import type { Hex } from "viem";
import { EXCHANGE_ADDRESS } from "../lib/eip712";
import {
  clearSessionKey,
  loadSessionKey,
  saveSessionKey,
} from "../lib/sessionKeyStore";

export type Account = {
  accountId: Hex;
  keyId: number;
  nonceKey: bigint;
  sessionKey: CryptoKeyPair;
};

export function getNonce(account: Account): bigint {
  const seq = BigInt(localStorage.getItem("ob:seq") ?? "0");
  return (account.nonceKey << 64n) | seq;
}

type AccountContextValue = {
  account: Account | null;
  loading: boolean;
  setAccount: (account: Account | null) => Promise<void>;
  incrementSeq: () => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

async function clearStoredAccount(): Promise<void> {
  localStorage.removeItem("ob:exchangeAddress");
  localStorage.removeItem("ob:accountId");
  localStorage.removeItem("ob:keyId");
  localStorage.removeItem("ob:nonceKey");
  localStorage.removeItem("ob:seq");
  await clearSessionKey();
}

async function loadAccount(): Promise<Account | null> {
  const storedAddress = localStorage.getItem("ob:exchangeAddress");
  if (storedAddress && storedAddress !== EXCHANGE_ADDRESS) {
    await clearStoredAccount();
    return null;
  }

  const accountId = localStorage.getItem("ob:accountId") as Hex | null;
  const keyIdStr = localStorage.getItem("ob:keyId");
  const nonceKeyStr = localStorage.getItem("ob:nonceKey");
  const sessionKey = await loadSessionKey();
  if (accountId && keyIdStr && nonceKeyStr && sessionKey) {
    return {
      accountId,
      keyId: Number(keyIdStr),
      nonceKey: BigInt(nonceKeyStr),
      sessionKey,
    };
  }
  return null;
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const { data: account = null, isLoading: loading } = useQuery({
    queryKey: ["account"],
    queryFn: loadAccount,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const setAccount = useCallback(
    async (account: Account | null) => {
      if (account) {
        localStorage.setItem("ob:exchangeAddress", EXCHANGE_ADDRESS);
        localStorage.setItem("ob:accountId", account.accountId);
        localStorage.setItem("ob:keyId", String(account.keyId));
        localStorage.setItem("ob:nonceKey", account.nonceKey.toString());
        localStorage.removeItem("ob:seq");
        await saveSessionKey(account.sessionKey);
      } else {
        await clearStoredAccount();
      }
      queryClient.setQueryData(["account"], account);
    },
    [queryClient],
  );

  const incrementSeq = useCallback(() => {
    const seq = BigInt(localStorage.getItem("ob:seq") ?? "0");
    localStorage.setItem("ob:seq", (seq + 1n).toString());
  }, []);

  return (
    <AccountContext.Provider
      value={{ account, loading, setAccount, incrementSeq }}
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
