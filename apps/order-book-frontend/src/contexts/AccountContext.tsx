import { createContext, useContext, useEffect, useState } from "react";
import type { Address, Hex } from "viem";

export type Account = {
  address: Address;
  privateKey: Hex;
  accountId: number;
};

type AccountContextValue = {
  account: Account | null;
  loading: boolean;
  setAccount: (a: Account | null) => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

const STORAGE_PREFIX = "ob:";

function clearStorage() {
  localStorage.removeItem(`${STORAGE_PREFIX}address`);
  localStorage.removeItem(`${STORAGE_PREFIX}privateKey`);
  localStorage.removeItem(`${STORAGE_PREFIX}accountId`);
  localStorage.removeItem(`${STORAGE_PREFIX}boot-id`);
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const address = localStorage.getItem(`${STORAGE_PREFIX}address`) as Address | null;
    const privateKey = localStorage.getItem(`${STORAGE_PREFIX}privateKey`) as Hex | null;
    const accountId = localStorage.getItem(`${STORAGE_PREFIX}accountId`);

    if (!address?.startsWith("0x") || !privateKey?.startsWith("0x") || accountId == null) {
      clearStorage();
      setLoading(false);
      return;
    }

    fetch("/api/boot-id")
      .then((res) => res.json())
      .then(({ id }: { id: string }) => {
        const savedBootId = localStorage.getItem(`${STORAGE_PREFIX}boot-id`);
        if (id !== savedBootId) {
          clearStorage();
          return;
        }
        setAccount({
          address,
          privateKey,
          accountId: Number(accountId),
        });
      })
      .catch(() => {
        clearStorage();
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <AccountContext.Provider value={{ account, loading, setAccount }}>
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
