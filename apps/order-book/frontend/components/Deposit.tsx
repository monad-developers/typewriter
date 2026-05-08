import { TokenAmount, USD } from "order-book-sdk";
import { useState } from "react";
import { useDepositMutation } from "../hooks/useDepositMutation";

const PRESETS = [100, 500, 1_000, 5_000];

export function Deposit() {
  const deposit = useDepositMutation();
  const [amount, setAmount] = useState<number>(500);

  const canSubmit = amount > 0 && !deposit.isPending;

  const onSubmit = async () => {
    if (!canSubmit) return;
    const { raw } = TokenAmount.from(amount, USD);
    await deposit.mutateAsync({ asset: USD, amount: raw });
  };

  return (
    <div className="max-w-xl w-full px-6 py-10 flex flex-col gap-6 font-mono">
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-2xl font-bold">Add funds</h2>
          <span className="text-[10px] uppercase tracking-wider font-semibold border border-black px-1.5 py-0.5">
            demo
          </span>
        </div>
        <p className="text-sm text-zinc-500">
          Practice funds, credited instantly.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500">
          Amount
        </div>
        <div className="grid grid-cols-4 gap-2">
          {PRESETS.map((value) => {
            const active = amount === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setAmount(value)}
                className={
                  active
                    ? "border border-black bg-black text-white py-3 text-sm cursor-pointer"
                    : "border border-black bg-white py-3 text-sm cursor-pointer hover:bg-zinc-50"
                }
              >
                ${value.toLocaleString()}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500">
          Source
        </div>
        <div className="flex items-center gap-3 border border-black px-3 py-3">
          <span className="w-3 h-3 rounded-full border border-black bg-black shrink-0" />
          <span className="flex-1">
            <span className="block text-sm font-semibold">
              Exchange demo treasury
            </span>
            <span className="block text-xs text-zinc-500">
              Test funds minted on your behalf
            </span>
          </span>
          <span className="text-xs text-zinc-500">Instant</span>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-zinc-200 pt-4">
        <Row label="Amount" value={`$${amount.toLocaleString()}`} />
        <Row label="Fee" value="$0.00" />
        <Row
          label="You receive"
          value={`$${amount.toLocaleString()} USD`}
          bold
        />
      </section>

      {deposit.isError ? (
        <div className="text-sm text-red-600">
          {deposit.error instanceof Error
            ? deposit.error.message
            : "Deposit failed"}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="border border-black bg-black text-white py-3 text-sm font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-800"
      >
        {deposit.isPending
          ? "Processing..."
          : `Deposit $${amount.toLocaleString()}`}
      </button>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className={bold ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}
