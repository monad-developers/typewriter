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
import {
  PageContainer,
  PageHeader,
  PageShell,
  Section,
} from "../components/ui/page";
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

const KEY_COLUMNS = ["Type", "Permissions", "Expiry", "Public key"];
const BALANCE_COLUMNS = ["Asset", "Amount"];
const MUTATION_COLUMNS = ["ID", "Block", "Bundle", "Status", "Description"];

const linkClass = "hover:underline decoration-1 underline-offset-2";

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
      <PageContainer>
        <PageHeader
          eyebrow="Account"
          title={account?.serial != null ? `#${account.serial}` : "…"}
        />

        <Section title="Balances">
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
                  <TR key={asset}>
                    <TD className="font-medium">
                      {assetSymbol(asset as Address)}
                    </TD>
                    <TD mono>{formatAssetAmount(asset as Address, amount)}</TD>
                  </TR>
                ))
              )}
            </tbody>
          </DataTable>
        </Section>

        <Section title="Keys" description={`${account?.keys.length ?? 0} authorized keys`}>
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
                  <TR key={k.publicKey}>
                    <TD className="font-medium">
                      {KEY_TYPE_LABELS[k.keyType]}
                    </TD>
                    <TD className="text-sm">
                      {formatPermissions(k.permissions)}
                    </TD>
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

        <Section
          title="Mutations"
          description={`${account?.mutations.length ?? 0} actions by this account`}
        >
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
                  <TR key={m.id}>
                    <TD mono>
                      <Link to={`/mutation/${m.id}`} className={linkClass}>
                        {m.id}
                      </Link>
                    </TD>
                    <TD mono>
                      {m.blockNumber ? (
                        <Link
                          to={`/block/${m.blockNumber}`}
                          className={linkClass}
                        >
                          {m.blockNumber}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD mono>
                      {m.bundleId ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
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
      </PageContainer>
    </PageShell>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "verified" || status === "finalized"
      ? "bg-emerald-50 text-emerald-700"
      : status === "voted" || status === "proposed"
        ? "bg-sky-50 text-sky-700"
        : status === "accepted"
          ? "bg-slate-100 text-slate-700"
          : status === "pending"
            ? "bg-amber-50 text-amber-700"
            : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center h-6 px-2 rounded-full text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  );
}
