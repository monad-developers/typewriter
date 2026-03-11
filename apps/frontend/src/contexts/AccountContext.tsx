import { createContext, useContext, useState } from "react";
import type { Address, Hex, WalletClient } from "viem";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { ANVIL_ACCOUNTS, RPC_URL } from "../constants";

export type Account = {
  address: Address;
  privateKey: Hex;
  walletClient: WalletClient;
};

type AccountContextValue = {
  account: Account | null;
  setAccount: (a: Account | null) => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(() => {
    const address = localStorage.getItem("address");
    const privateKey = localStorage.getItem("privateKey");
    const valid = ANVIL_ACCOUNTS.find(
      (a) => a.address === address && a.privateKey === privateKey,
    );

    if (valid) {
      return {
        ...valid,
        walletClient: createWalletClient({
          account: privateKeyToAccount(valid.privateKey),
          transport: http(RPC_URL),
          chain: anvil,
        }),
      };
    }

    return null;
  });

  return (
    <AccountContext.Provider value={{ account, setAccount }}>
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
