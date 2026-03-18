import { createContext, useContext, useState } from "react";
import type { Address, Hash, Hex } from "viem";

export type Account = {
  address: Address;
  privateKey: Hex;
};

export type TxStatus =
  | "pending"
  | "accepted"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified"
  | "reverted";

export type Tx = {
  hash: Hash;
  status: TxStatus;
  amount: bigint;
  to: Address;
  cost: bigint | null;
  blockNumber: bigint;
  preflightLatency: number | null;
  submissionLatency: number | null;
  timestamp: number;
};

type AccountContextValue = {
  account: Account | null;
  setAccount: (a: Account | null) => void;
  txs: Tx[];
  addTx: (tx: Tx, address?: Address) => void;
  updateTx: (hash: Hash, update: Partial<Tx>, address?: Address) => void;
};

// Use a separate storage key so fast-app txs don't collide with the normal app.
function txStorageKey(address: Address) {
  return `fast:txs:${address}`;
}

function loadTxs(address: Address): Tx[] {
  try {
    const raw = localStorage.getItem(txStorageKey(address));
    if (!raw) return [];
    return JSON.parse(raw).map((tx: any) => ({
      ...tx,
      amount: BigInt(tx.amount),
      cost: tx.cost != null ? BigInt(tx.cost) : null,
      blockNumber: BigInt(tx.blockNumber),
    }));
  } catch {
    return [];
  }
}

function saveTxs(address: Address, txs: Tx[]) {
  localStorage.setItem(
    txStorageKey(address),
    JSON.stringify(
      txs.map((tx) => ({
        ...tx,
        amount: tx.amount.toString(),
        cost: tx.cost?.toString() ?? null,
        blockNumber: tx.blockNumber.toString(),
      })),
    ),
  );
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(() => {
    const address = localStorage.getItem("address") as Address | null;
    const privateKey = localStorage.getItem("privateKey") as Hex | null;
    if (address?.startsWith("0x") && privateKey?.startsWith("0x")) {
      return { address, privateKey };
    }
    return null;
  });

  const [txs, setTxs] = useState<Tx[]>(() =>
    account ? loadTxs(account.address) : [],
  );

  function addTx(tx: Tx, address?: Address) {
    const addr = address ?? account?.address;
    setTxs((prev) => {
      const next = [tx, ...prev];
      if (addr) saveTxs(addr, next);
      return next;
    });
  }

  function updateTx(hash: Hash, update: Partial<Tx>, address?: Address) {
    const addr = address ?? account?.address;
    setTxs((prev) => {
      const next = prev.map((tx) =>
        tx.hash === hash ? { ...tx, ...update } : tx,
      );
      if (addr) saveTxs(addr, next);
      return next;
    });
  }

  return (
    <AccountContext.Provider
      value={{ account, setAccount, txs, addTx, updateTx }}
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
