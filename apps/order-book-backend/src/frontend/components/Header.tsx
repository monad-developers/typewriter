import { TokenAmount, USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useAccount } from "../hooks/useAccount";
import { useBalances } from "../hooks/useBalances";
import { useDepositMutation } from "../hooks/useDepositMutation";
import { Link } from "../lib/router";

export function Header() {
  const { account, setAccount } = useAccountContext();
  const { data } = useBalances(account?.accountId);
  const accountQuery = useAccount(account?.accountId);
  const depositMutation = useDepositMutation();

  const rawBalance = data?.balances[USD] ?? "0";
  const balance = TokenAmount.fromRaw(BigInt(rawBalance), USD).human;
  const serial = accountQuery.data?.serial;

  async function handleDeposit() {
    await depositMutation.mutateAsync({
      asset: USD,
      amount: TokenAmount.from(1000, USD).raw,
    });
  }

  return (
    <header className="w-full border-b px-4 py-3 flex items-center gap-6">
      <code className="text-sm">balance: ${balance}</code>
      <button
        type="button"
        onClick={() => void handleDeposit()}
        disabled={!account || depositMutation.isPending}
        className="border px-3 py-1 text-sm font-mono rounded disabled:opacity-50"
      >
        {depositMutation.isPending ? "depositing..." : "deposit"}
      </button>
      {depositMutation.error ? (
        <code className="text-sm text-red-600">
          {depositMutation.error instanceof Error
            ? depositMutation.error.message
            : "Deposit failed"}
        </code>
      ) : null}
      <span className="flex-1" />
      {serial != null ? (
        <Link
          to={`/account/${serial}`}
          className="text-sm font-mono text-blue-500 hover:underline"
        >
          view account
        </Link>
      ) : null}
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
