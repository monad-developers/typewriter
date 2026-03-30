import { formatEther } from "viem";
import { CURRENCIES, formatCurrency } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";
import { useExchangeState } from "../hooks/useExchangeState";

export function Header({
  denominationId,
  onDenominationChange,
}: {
  denominationId: number;
  onDenominationChange: (id: number) => void;
}) {
  const { account } = useAccountContext();
  const { data: state } = useExchangeState();

  const acct = state?.accounts[account?.accountId ?? -1];
  const balance = acct?.balances[denominationId] ?? "0";
  const currency = CURRENCIES[denominationId];

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
        balance: {currency ? formatCurrency(formatEther(BigInt(balance)), currency) : "—"}
      </code>
      <span className="flex-1" />
      <code className="text-sm text-gray-400">
        enter trade | cmd+enter trade all
      </code>
    </header>
  );
}
