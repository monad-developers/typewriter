import { createContext, useContext, useState } from "react";
import type {
  Address,
  Hash,
  Hex,
  LocalAccount,
  Transport,
  Chain,
  WalletClient,
} from "viem";
import { createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN, RPC_URL } from "../constants";
import { loggingTransport } from "../lib/loggingTransport";

function txStorageKey(address: Address) {
  return `txs:${address}`;
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

export type Account = {
  address: Address;
  privateKey: Hex;
  walletClient: WalletClient<Transport, Chain, LocalAccount>;
};

export type TxStatus =
  | "pending"
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
  accessListEnabled: boolean;
  setAccessListEnabled: (v: boolean) => void;
  preflightOptimizationsEnabled: boolean;
  setPreflightOptimizationsEnabled: (v: boolean) => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(() => {
    const address = localStorage.getItem("address") as Address | null;
    const privateKey = localStorage.getItem("privateKey") as Hex | null;

    if (address?.startsWith("0x") && privateKey?.startsWith("0x")) {
      return {
        address,
        privateKey,
        walletClient: createWalletClient({
          account: privateKeyToAccount(privateKey),
          transport: loggingTransport(RPC_URL),
          chain: CHAIN,
        }),
      };
    }

    return null;
  });

  const [txs, setTxs] = useState<Tx[]>(() =>
    account ? loadTxs(account.address) : [],
  );

  const [accessListEnabled, setAccessListEnabled] = useState(false);
  const [preflightOptimizationsEnabled, setPreflightOptimizationsEnabled] = useState(false);

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
      value={{ account, setAccount, txs, addTx, updateTx, accessListEnabled, setAccessListEnabled, preflightOptimizationsEnabled, setPreflightOptimizationsEnabled }}
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
