import { INSTRUMENTS } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";
import { useDepth } from "../hooks/useDepth";
import { usePrice } from "../hooks/usePrice";
import { fromLots, q32ToPrice } from "order-book-sdk";

const COLUMNS = [
  "",
  "inventory",
  "price",
  "25bp bid",
  "5bp bid",
  "1bp bid",
  "1bp ask",
  "5bp ask",
  "25bp ask",
  "buy",
  "sell",
];

const instruments = Object.entries(INSTRUMENTS) as [
  keyof typeof INSTRUMENTS,
  (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS],
][];

export function Exchange() {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account?.accountId);

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b h-10">
          {COLUMNS.map((col) => (
            <th
              key={col || "name"}
              className="text-left px-3 align-middle whitespace-nowrap"
            >
              <code>{col}</code>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {instruments.map(([name, inst]) => (
          <Row
            key={name}
            name={name}
            instrument={inst}
            balance={balancesData?.balances[inst.base] ?? "0"}
          />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  name,
  instrument,
  balance,
}: {
  name: string;
  instrument: (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS];
  balance: string;
}) {
  const { data: priceData } = usePrice(instrument.id);
  const { data: depthData } = useDepth(instrument.id);
  const price =
    priceData?.price != null
      ? `$${q32ToPrice(BigInt(priceData.price), instrument).toFixed(2)}`
      : "\u2014";

  const fmtDepth = (side: "bids" | "asks", bp: string) => {
    const lots = depthData?.[side][bp];
    if (lots == null) return "\u2014";

    return (
      Number(fromLots(BigInt(lots), instrument.baseLotExp)) /
      10 ** 18
    ).toFixed(2);
  };

  return (
    <tr className="border-b last:border-0 h-10">
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{name}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{balance}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{price}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{fmtDepth("bids", "25")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{fmtDepth("bids", "5")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{fmtDepth("bids", "1")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{fmtDepth("asks", "1")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{fmtDepth("asks", "5")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{fmtDepth("asks", "25")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <input
          type="number"
          min={0}
          placeholder="0"
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300"
        />
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <input
          type="number"
          min={0}
          placeholder="0"
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300"
        />
      </td>
    </tr>
  );
}
