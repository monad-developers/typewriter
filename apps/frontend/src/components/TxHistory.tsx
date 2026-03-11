const COLUMNS = [
  "status",
  "amount",
  "to",
  "cost",
  "preflight latency",
  "submission latency",
  "when",
];

const MOCK_TXS = [
  {
    id: "0x1a2b3c",
    status: "confirmed",
    amount: 1,
    to: "0xAbCd...Ef12",
    cost: "0.00021 MON",
    preflightLatency: "12ms",
    submissionLatency: "340ms",
    when: "2s ago",
  },
  {
    id: "0x4d5e6f",
    status: "pending",
    amount: 1,
    to: "0x1111...1111",
    cost: "0.00019 MON",
    preflightLatency: "9ms",
    submissionLatency: "280ms",
    when: "8s ago",
  },
  {
    id: "0x7g8h9i",
    status: "failed",
    amount: 1,
    to: "0x2222...2222",
    cost: "0.00020 MON",
    preflightLatency: "15ms",
    submissionLatency: "410ms",
    when: "1m ago",
  },
];

export function TxHistory() {
  return (
    <section className="w-full p-4">
      <table className="w-full  border-collapse">
        <thead>
          <tr className="border-b">
            {COLUMNS.map((col) => (
              <th key={col} className="text-left py-2 pr-6">
                <code className="">{col}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MOCK_TXS.map((tx) => (
            <tr key={tx.id} className="border-b last:border-0">
              <td className="py-2 pr-6">
                <code>{tx.status}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{tx.amount}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{tx.to}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{tx.cost}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{tx.preflightLatency}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{tx.submissionLatency}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{tx.when}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
