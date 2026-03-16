import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAccountContext } from "../contexts/AccountContext";
import { useTransfer } from "../hooks/useTransfer";

const AMOUNT = 1;

export function Transfer() {
  const { account } = useAccountContext();
  const transfer = useTransfer();
  const [amount, setAmount] = useState(AMOUNT);

  const { data: addresses } = useQuery({
    queryKey: ["addresses"],
    queryFn: async () => {
      const res = await fetch("/addresses");
      return (await res.json()) as Address[];
    },
    refetchInterval: 5000,
  });

  const recipients = addresses?.filter((a) => a !== account?.address) ?? [];
  const [to, setTo] = useState<Address>("" as Address);

  useEffect(() => {
    if (to === ("" as Address) && recipients.length > 0) {
      setTo(recipients[0]!);
    }
  }, [recipients, to]);

  if (!account) return null;

  return (
    <section className="w-full border-b px-4 py-4 flex flex-col gap-2">
      <h2 className="text-2xl font-bold">Transfer Tokens</h2>
      <div className="flex items-center gap-4">
      <code>
        send{" "}
        <input
          type="number"
          value={amount}
          min={0}
          onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
          className="w-16 border px-1"
        />{" "}
        to{" "}
        <select value={to} onChange={(e) => setTo(e.target.value as Address)}>
          {recipients.map((addr) => (
            <option key={addr} value={addr}>
              {addr}
            </option>
          ))}
        </select>
      </code>
      <button
        type="button"
        disabled={transfer.isPending || recipients.length === 0}
        onClick={() => transfer.mutate({ to, amount })}
        className="border px-3 py-1 text-sm bg-green-500 text-white rounded-md disabled:opacity-50"
      >
        send
      </button>
      </div>
    </section>
  );
}
