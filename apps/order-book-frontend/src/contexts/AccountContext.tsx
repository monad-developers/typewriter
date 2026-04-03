import { createContext, useContext, useEffect, useState } from "react";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CURRENCIES } from "../constants";
import { signDeposit } from "../hooks/useSign";

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
    (async () => {
      const privateKey = generatePrivateKey();
      const wallet = privateKeyToAccount(privateKey);
      const acc: Account = { address: wallet.address, privateKey };

      let nonce = 0n;
      for (const currency of CURRENCIES) {
        const amount = BigInt(Math.floor(50000 / currency.rateToUsd));
        const signed = await signDeposit(acc, nonce, {
          asset: currency.address,
          amount,
        });
        await fetch("/api/mint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signed),
        });
        nonce++;
      }

      setAccount(acc);
      setLoading(false);
    })().catch(() => setLoading(false));
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
