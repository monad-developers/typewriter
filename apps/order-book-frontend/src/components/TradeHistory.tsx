import { CURRENCIES, formatCurrency } from "../constants";

type TradeStatus = "accepted" | "proposed" | "finalized" | "verified";

type Trade = {
  id: string;
  status: TradeStatus;
  side: "buy" | "sell";
  baseId: number;
  quoteId: number;
  amount: string;
  price: string;
  timestamp: number;
};

const now = Date.now();

const FAKE_TRADES: Trade[] = [
  {
    id: "1",
    status: "verified",
    side: "buy",
    baseId: 0,
    quoteId: 1,
    amount: "5000",
    price: "0.1381",
    timestamp: now - 312_000,
  },
  {
    id: "2",
    status: "verified",
    side: "sell",
    baseId: 4,
    quoteId: 1,
    amount: "20000",
    price: "0.0066",
    timestamp: now - 245_000,
  },
  {
    id: "3",
    status: "finalized",
    side: "buy",
    baseId: 2,
    quoteId: 1,
    amount: "100000",
    price: "0.0120",
    timestamp: now - 98_000,
  },
  {
    id: "4",
    status: "proposed",
    side: "sell",
    baseId: 3,
    quoteId: 1,
    amount: "50000",
    price: "0.0109",
    timestamp: now - 42_000,
  },
  {
    id: "5",
    status: "proposed",
    side: "buy",
    baseId: 0,
    quoteId: 1,
    amount: "2500",
    price: "0.1381",
    timestamp: now - 18_000,
  },
  {
    id: "6",
    status: "accepted",
    side: "sell",
    baseId: 2,
    quoteId: 1,
    amount: "75000",
    price: "0.0120",
    timestamp: now - 3_000,
  },
];

const COLUMNS = ["status", "direction", "size", "rate", "when"];

function relativeTime(timestamp: number) {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function TradeHistory() {
  return (
    <section className="w-full border-t pt-4">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b h-10">
            {COLUMNS.map((col) => (
              <th
                key={col}
                className="text-left px-3 align-middle whitespace-nowrap"
              >
                <code>{col}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FAKE_TRADES.map((trade) => {
            const base = CURRENCIES[trade.baseId];
            const quote = CURRENCIES[trade.quoteId];
            return (
              <tr key={trade.id} className="border-b last:border-0 h-10">
                <td className="px-3 align-middle whitespace-nowrap">
                  <code>{trade.status}</code>
                </td>
                <td className="px-3 align-middle whitespace-nowrap">
                  <code>
                    {trade.side === "buy"
                      ? `${quote?.code} \u2192 ${base?.code}`
                      : `${base?.code} \u2192 ${quote?.code}`}
                  </code>
                </td>
                <td className="px-3 align-middle whitespace-nowrap">
                  <code>
                    {base ? formatCurrency(trade.amount, base) : trade.amount}
                  </code>
                </td>
                <td className="px-3 align-middle whitespace-nowrap">
                  <code>
                    {quote ? formatCurrency(trade.price, quote) : trade.price}
                  </code>
                </td>
                <td className="px-3 align-middle whitespace-nowrap">
                  <code>{relativeTime(trade.timestamp)}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
