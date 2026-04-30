import { createContext, useContext, useEffect, useState } from "react";
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
  loading: boolean;
  setAccount: (a: Account | null) => void;
  txs: Tx[];
  addTx: (tx: Tx, address?: Address) => void;
  updateTx: (hash: Hash, update: Partial<Tx>, address?: Address) => void;
};

// Use a separate storage key so fast-app txs don't collide with the normal app.
function txStorageKey(address: Address) {
  return `fast:txs:${address}`;
}

type SerializedTx = Omit<Tx, "amount" | "cost" | "blockNumber"> & {
  amount: string;
  cost: string | null;
  blockNumber: string;
};

function loadTxs(address: Address): Tx[] {
  try {
    const raw = localStorage.getItem(txStorageKey(address));
    if (!raw) return [];
    return (JSON.parse(raw) as SerializedTx[]).map((tx) => ({
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

function clearFastStorage() {
  localStorage.removeItem("fast:address");
  localStorage.removeItem("fast:privateKey");
  localStorage.removeItem("fast:boot-id");
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [txs, setTxs] = useState<Tx[]>([]);

  useEffect(() => {
    const address = localStorage.getItem("fast:address") as Address | null;
    const privateKey = localStorage.getItem("fast:privateKey") as Hex | null;

    if (!address?.startsWith("0x") || !privateKey?.startsWith("0x")) {
      clearFastStorage();
      setLoading(false);
      return;
    }

    fetch("/api/fast/boot-id")
      .then((res) => res.json())
      .then(({ id }: { id: string }) => {
        const savedBootId = localStorage.getItem("fast:boot-id");
        if (id !== savedBootId) {
          clearFastStorage();
          return;
        }
        setAccount({ address, privateKey });
        setTxs(loadTxs(address));
      })
      .catch(() => {
        clearFastStorage();
      })
      .finally(() => setLoading(false));
  }, []);

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
      value={{ account, loading, setAccount, txs, addTx, updateTx }}
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
