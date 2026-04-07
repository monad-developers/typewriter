import { CURRENCIES, formatCurrency } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";
import { useDepositMutation } from "../hooks/useDepositMutation";

export function Header({
  denominationId,
  onDenominationChange,
}: {
  denominationId: number;
  onDenominationChange: (id: number) => void;
}) {
  const { account, loading } = useAccountContext();
  const { data } = useBalances(account?.address);
  const depositMutation = useDepositMutation();

  const currency = CURRENCIES[denominationId];
  const depositAmount = currency
    ? BigInt(Math.floor(50000 / currency.rateToUsd))
    : null;
  const balance = currency ? (data?.balances[currency.address] ?? "0") : "0";

  async function handleDeposit() {
    if (!currency || depositAmount === null) return;

    await depositMutation.mutateAsync({
      asset: currency.address,
      amount: depositAmount,
    });
  }

  return (
    <header className="w-full border-b px-4 py-3 flex items-center gap-6">
      <div className="flex items-center gap-2">
        <code className="text-sm text-gray-500">denomination:</code>
        <select
          value={denominationId}
          onChange={(e) => onDenominationChange(Number(e.target.value))}
          className="border px-2 py-1 text-sm font-mono rounded"
        >
          {CURRENCIES.map((c, i) => (
            <option key={c.code} value={i}>
              {c.flag} {c.code}
            </option>
          ))}
        </select>
      </div>
      <code className="text-sm">
        balance: {currency ? formatCurrency(balance, currency) : "\u2014"}
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
        disabled={loading || !account || !currency || depositMutation.isPending}
        className="border px-3 py-1 text-sm font-mono rounded disabled:opacity-50"
      >
        {depositMutation.isPending ? "depositing..." : "deposit"}
      </button>
      <code className="text-sm text-gray-400">
        enter trade | cmd+enter trade all
      </code>
    </header>
  );
}
