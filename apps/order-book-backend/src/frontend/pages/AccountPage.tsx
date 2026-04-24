import {
  GOLD,
  PERM_ADD_INSTRUMENT,
  PERM_AUTHORIZE,
  PERM_CLOSE_ORDER,
  PERM_DEPOSIT,
  PERM_LIMIT_ORDER,
  PERM_MARKET_ORDER,
  PERM_REVOKE,
  PERM_WITHDRAW,
  TokenAmount,
  USD,
  WTIOIL,
} from "order-book-sdk";
import type { Address } from "viem";
import { MutationDescription } from "../components/MutationDescription";
import { PageHeader, PageShell, Section } from "../components/ui/page";
import {
  DataTable,
  Empty,
  TD,
  TH,
  THead,
  TR,
} from "../components/ui/table";
import { useAccount } from "../hooks/useAccount";
import { Link, useMatch } from "../lib/router";

const ASSET_SYMBOLS: Record<Address, string> = {
  [USD]: "USD",
  [GOLD]: "GOLD",
  [WTIOIL]: "WTIOIL",
};

const KEY_TYPE_LABELS = ["P256", "WebAuthnP256", "Secp256k1"] as const;

const PERMISSIONS = [
  { bit: PERM_AUTHORIZE, name: "authorize" },
  { bit: PERM_REVOKE, name: "revoke" },
  { bit: PERM_CLOSE_ORDER, name: "closeOrder" },
  { bit: PERM_LIMIT_ORDER, name: "limitOrder" },
  { bit: PERM_MARKET_ORDER, name: "marketOrder" },
  { bit: PERM_ADD_INSTRUMENT, name: "addInstrument" },
  { bit: PERM_DEPOSIT, name: "deposit" },
  { bit: PERM_WITHDRAW, name: "withdrawal" },
];

const KEY_COLUMNS = ["type", "permissions", "expiry", "public key"];
const BALANCE_COLUMNS = ["asset", "amount"];
const MUTATION_COLUMNS = ["id", "block", "bundle", "status", "description"];

const linkClass = "text-indigo-600 hover:text-indigo-700 hover:underline";

function shortHex(hex: string) {
  return `${hex.slice(0, 10)}…${hex.slice(-8)}`;
}

function displayPublicKey(keyType: number, publicKey: string) {
  if (keyType === 2) return shortHex(`0x${publicKey.slice(-40)}`);
  return shortHex(publicKey);
}

function assetSymbol(asset: Address) {
  return ASSET_SYMBOLS[asset] ?? asset;
}

function formatExpiry(expiry: number) {
  if (expiry === 0) return "no expiry";
  const now = Math.floor(Date.now() / 1000);
  if (expiry < now) return "expired";
  return new Date(expiry * 1000).toISOString();
}

function formatPermissions(permissions: number) {
  if (permissions === 0) return "none";
  const names = PERMISSIONS.filter((p) => permissions & p.bit).map(
    (p) => p.name,
  );
  return names.join(", ") || `0x${permissions.toString(16)}`;
}

function formatAssetAmount(asset: Address, amount: string) {
  return `${TokenAmount.fromRaw(BigInt(amount), asset).human.toFixed(2)} ${assetSymbol(asset)}`;
}

export function AccountPage() {
  const match = useMatch<"id">("/account/:id");
  const idOrAddress = match?.params.id;
  const query = useAccount(idOrAddress);
  const account = query.data;

  return (
    <PageShell>
      <Section>
        <PageHeader
          eyebrow="account"
          title={account?.serial != null ? `#${account.serial}` : "…"}
        />
      </Section>

      <Section title="balances">
        <DataTable>
          <THead>
            <TR>
              {BALANCE_COLUMNS.map((col) => (
                <TH key={col}>{col}</TH>
              ))}
            </TR>
          </THead>
          <tbody>
            {account && Object.keys(account.balances).length === 0 ? (
              <Empty colSpan={BALANCE_COLUMNS.length}>No balances</Empty>
            ) : (
              account &&
              Object.entries(account.balances).map(([asset, amount]) => (
                <TR key={asset} zebra>
                  <TD className="font-semibold">
                    {assetSymbol(asset as Address)}
                  </TD>
                  <TD mono>{formatAssetAmount(asset as Address, amount)}</TD>
                </TR>
              ))
            )}
          </tbody>
        </DataTable>
      </Section>

      <Section title={`keys (${account?.keys.length ?? 0})`}>
        <DataTable>
          <THead>
            <TR>
              {KEY_COLUMNS.map((col) => (
                <TH key={col}>{col}</TH>
              ))}
            </TR>
          </THead>
          <tbody>
            {account && account.keys.length === 0 ? (
              <Empty colSpan={KEY_COLUMNS.length}>No keys</Empty>
            ) : (
              account?.keys.map((k) => (
                <TR key={k.publicKey} zebra>
                  <TD className="font-semibold">{KEY_TYPE_LABELS[k.keyType]}</TD>
                  <TD className="text-sm">{formatPermissions(k.permissions)}</TD>
                  <TD mono>{formatExpiry(k.expiry)}</TD>
                  <TD mono className="text-muted-foreground">
                    {displayPublicKey(k.keyType, k.publicKey)}
                  </TD>
                </TR>
              ))
            )}
          </tbody>
        </DataTable>
      </Section>

      <Section title={`mutations (${account?.mutations.length ?? 0})`} bordered={false}>
        <DataTable>
          <THead>
            <TR>
              {MUTATION_COLUMNS.map((col) => (
                <TH key={col}>{col}</TH>
              ))}
            </TR>
          </THead>
          <tbody>
            {account && account.mutations.length === 0 ? (
              <Empty colSpan={MUTATION_COLUMNS.length}>No mutations</Empty>
            ) : (
              account?.mutations.map((m) => (
                <TR key={m.id} zebra>
                  <TD mono>
                    <Link to={`/mutation/${m.id}`} className={linkClass}>
                      {m.id}
                    </Link>
                  </TD>
                  <TD mono>
                    {m.blockNumber ? (
                      <Link to={`/block/${m.blockNumber}`} className={linkClass}>
                        {m.blockNumber}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD mono>{m.bundleId ?? <span className="text-muted-foreground">—</span>}</TD>
                  <TD>
                    <StatusPill status={m.status} />
                  </TD>
                  <TD className="text-sm">
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

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "verified" || status === "finalized"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status === "voted" || status === "proposed"
        ? "bg-indigo-50 text-indigo-700 border-indigo-200"
        : status === "accepted"
          ? "bg-sky-50 text-sky-700 border-sky-200"
          : status === "pending"
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded border text-[10px] uppercase tracking-[0.1em] font-semibold ${tone}`}
    >
      {status}
    </span>
  );
}
