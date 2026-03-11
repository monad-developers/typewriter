import { useState } from "react";
import type { Address } from "viem";
import { ANVIL_ACCOUNTS } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";

const AMOUNT = 1;

export function Transfer() {
  const { account } = useAccountContext();
  const addresses = ANVIL_ACCOUNTS.filter(
    (a) => a.address !== account?.address,
  ).map((a) => a.address as Address);
  const [to, setTo] = useState<Address>(addresses[0] ?? ("" as Address));
  const [amount, setAmount] = useState(AMOUNT);

  if (!account) return null;

  return (
    <section className="w-full border-b px-4 h-12 flex items-center gap-4 overflow-hidden">
      <code>
        send{" "}
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          disabled
          className="w-16 border px-1 cursor-not-allowed"
        />{" "}
        to{" "}
        <select
          value={to}
          onChange={(e) => setTo(e.target.value as Address)}
          disabled
        >
          {addresses.map((addr) => (
            <option key={addr} value={addr}>
              {addr}
            </option>
          ))}
        </select>
      </code>
      <button
        type="button"
        className="border px-3 py-1 text-sm bg-green-500 text-white rounded-md"
      >
        send
      </button>
    </section>
  );
}
