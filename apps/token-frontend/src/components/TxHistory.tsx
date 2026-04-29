import { formatEther } from "viem";
import type { TxStatus } from "../contexts/AccountContext";
import { useAccountContext } from "../contexts/AccountContext";
import { useBlockNumber } from "../hooks/useBlockNumber";

function getStatus(confirmations: bigint): TxStatus {
  if (confirmations >= 5n) return "verified";
  if (confirmations >= 2n) return "finalized";
  if (confirmations >= 1n) return "voted";
  return "proposed";
}

const COLUMNS = [
  "status",
  "amount",
  "to",
  "cost",
  "preflight latency",
  "submission latency",
  "when",
];

function relativeTime(timestamp: number) {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function TxHistory() {
  const { txs } = useAccountContext();
  const blockNumber = useBlockNumber();

  return (
    <section className="w-full p-4">
      <h2 className="text-2xl font-bold mb-4">View Transactions</h2>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b">
            {COLUMNS.map((col) => (
              <th key={col} className="text-left py-2 pr-6">
                <code>{col}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {txs.map((tx) => (
            <tr key={tx.hash} className="border-b last:border-0">
              <td className="py-2 pr-6">
                <code>
                  {blockNumber != null
                    ? getStatus(blockNumber - tx.blockNumber)
                    : tx.status}
                </code>
              </td>
              <td className="py-2 pr-6">
                <code>{formatEther(tx.amount)}</code>
              </td>
              <td className="py-2 pr-6">
                <code>{shortAddr(tx.to)}</code>
              </td>
              <td className="py-2 pr-6">
                <code>
                  {tx.cost != null ? `${formatEther(tx.cost)} MON` : "—"}
                </code>
              </td>
              <td className="py-2 pr-6">
                <code>
                  {tx.preflightLatency != null
                    ? `${Math.round(tx.preflightLatency)}ms`
                    : "—"}
                </code>
              </td>
              <td className="py-2 pr-6">
                <code>
                  {tx.submissionLatency != null
                    ? `${Math.round(tx.submissionLatency)}ms`
                    : "—"}
                </code>
              </td>
              <td className="py-2 pr-6">
                <code>{relativeTime(tx.timestamp)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
