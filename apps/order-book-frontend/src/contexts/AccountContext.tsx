import { createContext, useContext, useEffect, useState } from "react";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type Account = {
  address: Address;
  privateKey: `0x${string}`;
};

type AccountContextValue = {
  account: Account | null;
  loading: boolean;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const privateKey = generatePrivateKey();
      const wallet = privateKeyToAccount(privateKey);
      const acc: Account = { address: wallet.address, privateKey };

      setAccount(acc);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, []);

  return (
    <AccountContext.Provider value={{ account, loading }}>
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
