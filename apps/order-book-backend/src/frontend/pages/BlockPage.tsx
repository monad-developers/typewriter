import { MutationDescription } from "../components/MutationDescription";
import { Field, PageShell, Section } from "../components/ui/page";
import {
  DataTable,
  Empty,
  TD,
  TH,
  THead,
  TR,
} from "../components/ui/table";
import { useBlock } from "../hooks/useBlock";
import { type ApiMutation, useMutations } from "../hooks/useMutations";
import { Link, useMatch } from "../lib/router";

const MUTATION_COLUMNS = ["id", "bundle", "status", "account", "description"];

const linkClass = "text-sky-700 hover:underline";

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

  const rows = (mutations.data ?? []).filter(
    (m): m is typeof m & { bundleId: number } => m.bundleId != null,
  );

  const bundleOrder = new Map<number, number>();
  for (const m of rows) {
    if (!bundleOrder.has(m.bundleId)) {
      bundleOrder.set(m.bundleId, bundleOrder.size);
    }
  }

  return (
    <PageShell>
      <Section>
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-1">
          block
        </div>
        <div className="text-2xl font-semibold tabular-nums mb-4">
          {block.data?.number ?? "…"}
        </div>
        <div className="flex flex-col gap-1.5">
          <Field label="onchain">
            {block.data ? (
              <a
                href={`https://testnet.monadscan.com/block/${block.data.number}`}
                target="_blank"
                rel="noreferrer"
                className={linkClass}
              >
                view on monadscan ↗
              </a>
            ) : (
              "…"
            )}
          </Field>
          <Field label="timestamp">
            <span className="tabular-nums">{block.data?.timestamp ?? "…"}</span>
          </Field>
          <Field label="tx hash">
            {transactionHash ? (
              <a
                href={`https://testnet.monadscan.com/tx/${transactionHash}`}
                target="_blank"
                rel="noreferrer"
                className={`${linkClass} tabular-nums`}
              >
                {transactionHash}
              </a>
            ) : (
              "…"
            )}
          </Field>
        </div>
      </Section>

      <Section title={`mutations (${mutations.data?.length ?? 0})`} bordered={false}>
        <DataTable>
          <THead>
            <TR>
              {MUTATION_COLUMNS.map((col) => (
                <TH key={col}>{col}</TH>
              ))}
            </TR>
          </THead>
          <tbody>
            {mutations.data && rows.length === 0 ? (
              <Empty colSpan={MUTATION_COLUMNS.length}>
                no mutations in this block
              </Empty>
            ) : (
              rows.map((m) => (
                <TR
                  key={m.id}
                  className={
                    (bundleOrder.get(m.bundleId) ?? 0) % 2 === 0
                      ? undefined
                      : "bg-muted/30"
                  }
                >
                  <TD className="tabular-nums">
                    <Link to={`/mutation/${m.id}`} className={linkClass}>
                      {m.id}
                    </Link>
                  </TD>
                  <TD className="tabular-nums">{m.bundleId}</TD>
                  <TD>
                    <span className="text-muted-foreground">{m.status}</span>
                  </TD>
                  <TD className="tabular-nums">
                    <Link
                      to={`/account/${m.accountSerial ?? m.account}`}
                      className={linkClass}
                    >
                      {m.accountSerial != null
                        ? m.accountSerial
                        : shortAddr(m.account)}
                    </Link>
                  </TD>
                  <TD>
                    <MutationDescription mutation={m} />
                  </TD>
                </TR>
              ))
            )}
          </tbody>
        </DataTable>
      </Section>
    </PageShell>
  );
}
