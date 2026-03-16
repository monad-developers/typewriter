import { useRpcLog } from "../lib/rpcStore";

export function RpcLog() {
  const entries = useRpcLog();

  return (
    <div className="flex flex-col h-full w-80">
      <code className="text-sm font-bold mb-1">RPC Request Log</code>
      <div className="overflow-y-auto flex-1 border rounded text-xs">
        {entries.length === 0 ? (
          <div className="p-2 text-gray-400">
            <code>No RPC calls yet</code>
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 px-2 py-1 border-b font-mono"
            >
              <span
                className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                  entry.status === "ok" ? "bg-green-500" : "bg-red-500"
                }`}
              />
              <code className="flex-1 truncate">{entry.method}</code>
              <code className="text-gray-500 flex-shrink-0">
                {entry.duration.toFixed(0)}ms
              </code>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
