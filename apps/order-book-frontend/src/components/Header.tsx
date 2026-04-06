import { CURRENCIES, formatCurrency } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";

export function Header({
  denominationId,
  onDenominationChange,
}: {
  denominationId: number;
  onDenominationChange: (id: number) => void;
}) {
  const { account } = useAccountContext();
  const { data } = useBalances(account?.address);

  const currency = CURRENCIES[denominationId];
  const balance =
    currency && data?.balances[currency.address]
      ? data.balances[currency.address]
      : "0";

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
      <span className="flex-1" />
      <code className="text-sm text-gray-400">
        enter trade | cmd+enter trade all
      </code>
    </header>
  );
}
