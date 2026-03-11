import { useState } from "react";

const AMOUNT = 1;

const ADDRESSES = [
  "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
  "0x4444444444444444444444444444444444444444",
];

export function Transfer() {
  const [to, setTo] = useState(ADDRESSES[0]);
  const [amount, setAmount] = useState(AMOUNT);

  return (
    <section className="w-full border-b px-4 h-12 flex items-center gap-4 overflow-hidden">
      <code>
        send{" "}
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          disabled
          className="w-16 border px-1"
        />
        {" "}to{" "}
        <select value={to} onChange={(e) => setTo(e.target.value)} disabled>
          {ADDRESSES.map((addr) => (
            <option key={addr} value={addr}>
              {addr}
            </option>
          ))}
        </select>
      </code>
      <button className="border px-3 py-1 text-sm bg-green-500 text-white rounded-md">send</button>
    </section>
  );
}
