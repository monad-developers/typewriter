import { createContext, useContext } from "react";

export type Account = {
  accountId: number;
};

type AccountContextValue = {
  account: Account;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  return (
    <AccountContext.Provider value={{ account: { accountId: 0 } }}>
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
