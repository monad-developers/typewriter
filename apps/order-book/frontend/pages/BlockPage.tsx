import { MutationDescription } from "../components/MutationDescription";
import { useBlock } from "../hooks/useBlock";
import { type ApiMutation, useMutations } from "../hooks/useMutations";
import { Link, useMatch } from "../lib/router";

const MUTATION_COLUMNS = ["id", "status", "account", "description"];

const linkClass = "text-blue-500 hover:underline";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function dedupeTransactionHash(mutations: ApiMutation[]): string | null {
  return mutations[0]?.transactionHash ?? null;
}

export function BlockPage() {
  const match = useMatch<"number">("/block/:number");
  const number = match?.params.number;

  const block = useBlock(number);
  const mutations = useMutations(number);

  const transactionHash = mutations.data
    ? dedupeTransactionHash(mutations.data)
    : null;

  const rows = mutations.data ?? [];

  return (
    <div className="min-h-screen w-full flex flex-col">
      <section className="w-full border-b p-4 flex flex-col gap-2">
        <h2 className="text-2xl font-bold">Block</h2>
        <code>
          number:{" "}
          {block.data ? (
            <a
              href={`https://testnet.monadscan.com/block/${block.data.number}`}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              {block.data.number}
            </a>
          ) : (
            "..."
          )}
        </code>
        <code>timestamp: {block.data?.timestamp ?? "..."}</code>
        <code>
          transaction:{" "}
          {transactionHash ? (
            <a
              href={`https://testnet.monadscan.com/tx/${transactionHash}`}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              {transactionHash}
            </a>
          ) : (
            "..."
          )}
        </code>
      </section>

      <section className="w-full p-4">
        <h2 className="text-2xl font-bold mb-4">
          Messages ({mutations.data?.length ?? 0})
        </h2>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b">
              {MUTATION_COLUMNS.map((col) => (
                <th key={col} className="text-left py-2 pr-6">
                  <code>{col}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mutations.data && rows.length === 0 ? (
              <tr>
                <td
                  colSpan={MUTATION_COLUMNS.length}
                  className="py-2 pr-6 text-muted-foreground"
                >
                  <code>No messages in this block</code>
                </td>
              </tr>
            ) : (
              rows.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="py-2 pr-6">
                    <code>
                      <Link to={`/mutation/${m.id}`} className={linkClass}>
                        {m.id}
                      </Link>
                    </code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{m.status}</code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>
                      <Link
                        to={`/account/${m.signature_account}`}
                        className={linkClass}
                      >
                        {shortAddr(m.signature_account)}
                      </Link>
                    </code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>
                      <MutationDescription mutation={m} />
                    </code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
