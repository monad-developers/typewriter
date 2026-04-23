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

const KEY_COLUMNS = ["type", "permissions", "expiry", "publicKey"];
const BALANCE_COLUMNS = ["asset", "amount"];
const MUTATION_COLUMNS = ["id", "block", "bundle", "status", "description"];

const linkClass = "text-blue-500 hover:underline";

function shortHex(hex: string) {
  return `${hex.slice(0, 10)}...${hex.slice(-8)}`;
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
    <div className="min-h-screen w-full flex flex-col">
      <section className="w-full border-b p-4 flex flex-col gap-2">
        <h2 className="text-2xl font-bold">Account</h2>
        <code>id: {account?.serial ?? "..."}</code>
      </section>

      <section className="w-full p-4">
        <h2 className="text-2xl font-bold mb-4">Balances</h2>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b">
              {BALANCE_COLUMNS.map((col) => (
                <th key={col} className="text-left py-2 pr-6">
                  <code>{col}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {account && Object.keys(account.balances).length === 0 ? (
              <tr>
                <td
                  colSpan={BALANCE_COLUMNS.length}
                  className="py-2 pr-6 text-muted-foreground"
                >
                  <code>No balances</code>
                </td>
              </tr>
            ) : (
              account &&
              Object.entries(account.balances).map(([asset, amount]) => (
                <tr key={asset} className="border-b last:border-0">
                  <td className="py-2 pr-6">
                    <code>{assetSymbol(asset as Address)}</code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{formatAssetAmount(asset as Address, amount)}</code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="w-full p-4">
        <h2 className="text-2xl font-bold mb-4">
          Keys ({account?.keys.length ?? 0})
        </h2>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b">
              {KEY_COLUMNS.map((col) => (
                <th key={col} className="text-left py-2 pr-6">
                  <code>{col}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {account && account.keys.length === 0 ? (
              <tr>
                <td
                  colSpan={KEY_COLUMNS.length}
                  className="py-2 pr-6 text-muted-foreground"
                >
                  <code>No keys</code>
                </td>
              </tr>
            ) : (
              account?.keys.map((k) => (
                <tr key={k.publicKey} className="border-b last:border-0">
                  <td className="py-2 pr-6">
                    <code>{KEY_TYPE_LABELS[k.keyType]}</code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{formatPermissions(k.permissions)}</code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{formatExpiry(k.expiry)}</code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{displayPublicKey(k.keyType, k.publicKey)}</code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="w-full p-4">
        <h2 className="text-2xl font-bold mb-4">
          Mutations ({account?.mutations.length ?? 0})
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
            {account && account.mutations.length === 0 ? (
              <tr>
                <td
                  colSpan={MUTATION_COLUMNS.length}
                  className="py-2 pr-6 text-muted-foreground"
                >
                  <code>No mutations</code>
                </td>
              </tr>
            ) : (
              account?.mutations.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="py-2 pr-6">
                    <code>
                      <Link to={`/mutation/${m.id}`} className={linkClass}>
                        {m.id}
                      </Link>
                    </code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>
                      {m.blockNumber ? (
                        <Link
                          to={`/block/${m.blockNumber}`}
                          className={linkClass}
                        >
                          {m.blockNumber}
                        </Link>
                      ) : (
                        "..."
                      )}
                    </code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{m.bundleId ?? "..."}</code>
                  </td>
                  <td className="py-2 pr-6">
                    <code>{m.status}</code>
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
