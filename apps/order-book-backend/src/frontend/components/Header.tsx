import { USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";
import { useDepositMutation } from "../hooks/useDepositMutation";

export function Header() {
  const { account, setAccount } = useAccountContext();
  const { data } = useBalances(account?.accountId);
  const depositMutation = useDepositMutation();

  const balance = data?.balances[USD] ?? "0";

  async function handleDeposit() {
    await depositMutation.mutateAsync({
      asset: USD,
      amount: 50000n,
    });
  }

  return (
    <header className="w-full border-b px-4 py-3 flex items-center gap-6">
      <code className="text-sm">
        balance: ${balance}
      </code>
      {depositMutation.error ? (
        <code className="text-sm text-red-600">
          {depositMutation.error instanceof Error
            ? depositMutation.error.message
            : "Deposit failed"}
        </code>
      ) : null}
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => void handleDeposit()}
        disabled={!account || depositMutation.isPending}
        className="border px-3 py-1 text-sm font-mono rounded disabled:opacity-50"
      >
        {depositMutation.isPending ? "depositing..." : "deposit"}
      </button>
      <button
        type="button"
        onClick={() => void setAccount(null)}
        className="border px-3 py-1 text-sm font-mono rounded hover:bg-gray-50"
      >
        sign out
      </button>
    </header>
  );
}
