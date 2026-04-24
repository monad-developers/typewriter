import architectureDiagram from "../architecture.svg";
import { CodeBlock } from "../components/CodeBlock";
import { Info } from "../components/Info";
import { InlineCode } from "../components/InlineCode";
import { Link } from "../lib/router";

const CHAIN_ID = Number(process.env.BUN_PUBLIC_CHAIN_ID ?? "0");
const EXCHANGE_ADDRESS =
  process.env.BUN_PUBLIC_EXCHANGE_ADDRESS ??
  "0x0000000000000000000000000000000000000000";

const CHAIN_NAMES: Record<number, string> = {
  10143: "Monad testnet",
  31337: "Anvil (local)",
};
const CHAIN_NAME = CHAIN_NAMES[CHAIN_ID] ?? `Chain ${CHAIN_ID}`;

export function AboutOrderBook() {
  const apiUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";
  return (
    <div className="min-h-screen w-full flex flex-col">
      <main className="max-w-3xl mx-auto px-6 py-12 flex flex-col gap-12">
        {/* What is this */}
        <section>
          <h2 id="exchange" className="text-2xl font-bold mb-4 scroll-mt-24">
            Exchange (demo)
          </h2>
          <p className="leading-relaxed mb-4">
            An experimental order book on Monad testnet.
          </p>

          <h3
            id="features"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Features
          </h3>
          <ul className="leading-relaxed list-disc pl-6 mb-4 space-y-1">
            <li>
              <strong>Cancel prioritization.</strong> Orders are sequenced:
              cancel, limit, market; so quote updates are never stuck behind
              incoming flow.
            </li>
            <li>
              <strong>50ms batch windows.</strong> Orders are accepted within
              50ms.
            </li>
            <li>
              <strong>Pro-rata matching.</strong> Fills at the clearing price
              are allocated proportionally to order size rather than by arrival
              time.
            </li>
            <li>
              <strong>Session-key and modern auth.</strong> Passkey at sign-in,
              ephemeral session keys with scoped permissions for order placement
              and cancellation.
            </li>
            <li>
              <strong>Self-contained stack.</strong> No third-party sequencers,
              relays, wallets, or proposer-builder auctions.
            </li>
            <li>
              <strong>Non-custodial with a trustless exit.</strong> Balances,
              orders, and matching rules all live onchain; users can withdraw
              and force-include orders directly against the contract without
              backend cooperation.
            </li>
          </ul>

          <h3 id="gas" className="text-lg font-semibold mt-6 mb-2 scroll-mt-24">
            Gas
          </h3>
          <p className="leading-relaxed mb-4">
            Measured per-op marginal gas for a realistic batch.
          </p>
          <table className="w-full text-sm border border-border">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2">Operation</th>
                <th className="px-3 py-2">Gas</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2 font-semibold">market order</td>
                <td className="px-3 py-2">27k — 37k</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2 font-semibold">limit order</td>
                <td className="px-3 py-2">47k — 69k</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-semibold">cancel order</td>
                <td className="px-3 py-2">35k</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* CTA */}
        <section>
          <Link
            to="/exchange"
            className="block border rounded-lg overflow-hidden hover:border-foreground/40 transition-colors"
          >
            {/* TODO: replace with a real screenshot or OG preview asset */}
            <img
              src="/exchange-preview.png"
              alt="Exchange UI preview"
              className="w-full block bg-zinc-100"
              style={{ aspectRatio: "16 / 9", objectFit: "cover" }}
            />
            <div className="px-4 py-3 border-t flex items-center justify-between">
              <span className="text-sm font-semibold">Open the exchange</span>
              <span className="text-sm text-foreground hover:underline decoration-1 underline-offset-2">/exchange →</span>
            </div>
          </Link>
        </section>

        {/* Accounts */}
        <section>
          <h2 id="accounts" className="text-2xl font-bold mb-4 scroll-mt-24">
            Accounts
          </h2>
          <p className="leading-relaxed mb-4">
            The exchange ships a modern account system natively: passkey
            authentication, scoped session keys, and concurrent transactions.
          </p>

          <h3
            id="keys"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Keys
          </h3>
          <p className="leading-relaxed mb-4">
            An account has multiple keys, each able to authorize actions on
            behalf of the account.
          </p>
          <ul className="leading-relaxed list-disc pl-6 mb-4 space-y-1">
            <li>
              <strong>Modern signature algorithm.</strong> P256, WebAuthn-P256,
              or secp256k1. P256 and WebAuthn-P256 verify through the{" "}
              <InlineCode>0x100</InlineCode> precompile; secp256k1 uses{" "}
              <InlineCode>ecrecover</InlineCode>.
            </li>
            <li>
              <strong>Expiry.</strong> A key is only valid up to its expiry
              date.
            </li>
            <li>
              <strong>Permissions.</strong> An 8-bit mask gating every action. A
              key without <InlineCode>PERM_WITHDRAW</InlineCode> cannot sign a
              withdrawal, a key without{" "}
              <InlineCode>PERM_LIMIT_ORDER</InlineCode> cannot post liquidity,
              and so on.
            </li>
          </ul>
          <CodeBlock
            title="Account.sol"
            lang="solidity"
            code={`enum KeyType { P256, WebAuthnP256, Secp256k1 }

struct Key {
    uint40 expiry;
    KeyType keyType;
    uint8 permissions;
    bytes publicKey;
}`}
          />
          <p className="leading-relaxed mb-4">
            A typical account holds at least two keys: a long-lived "root" with
            full permissions, and a short-lived session key with stricter
            permissions.
          </p>
          <Info title="info">
            <Link to="/exchange" className="text-foreground hover:underline decoration-1 underline-offset-2">
              /exchange
            </Link>{" "}
            uses a session key: a non-extractable P-256{" "}
            <InlineCode>CryptoKeyPair</InlineCode> generated via{" "}
            <InlineCode>crypto.subtle.generateKey</InlineCode> and stored in{" "}
            <InlineCode>IndexedDB</InlineCode>, origin-scoped to this domain.
            It's registered at sign-in and signs every order so the root key is
            never required.
          </Info>
          {/* TODO(kyle) build a functioning example into the docs */}
          <h3
            id="nonces"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Concurrent transactions
          </h3>
          <p className="leading-relaxed mb-4">
            Nonces prevent replay and encode dependencies: each transaction
            carries a number that has to be one greater than the last, and
            signature validation rejects any transaction whose nonce isn't next
            in line. The standard EVM account has a single nonce counter, so
            transaction concurrency is limited.
          </p>
          <p className="leading-relaxed mb-4">
            This exchange allows multiple parallel transactions by splitting the
            256 bit nonce into a 192 bit key and 64 bit sequence, like{" "}
            <a
              href="https://eips.ethereum.org/EIPS/eip-4337"
              target="_blank"
              rel="noreferrer"
              className="text-foreground hover:underline decoration-1 underline-offset-2"
            >
              ERC-4337
            </a>
            . Use different keys for independent flows that shouldn't block each
            other; use the same key when a transaction should only execute after
            its predecessor.
          </p>
          <CodeBlock
            title="Exchange.sol"
            lang="solidity"
            code={`struct Account {
    mapping(uint192 => uint64) nonces; // nonce key => sequence
    Key[] keys;
    // ...
}`}
          />
        </section>

        {/* Matching */}
        <section>
          <h2 id="order-book" className="text-2xl font-bold mb-4 scroll-mt-24">
            Order book
          </h2>
          <p className="leading-relaxed mb-4">
            The order book is tuned for fast confirmations and healthy depth.
            Orders clear in 50ms batches, and in-batch sequencing gives makers
            priority.
          </p>

          <h3
            id="batches"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            50ms batch windows
          </h3>
          <p className="leading-relaxed mb-4">
            Orders are acknowledged in under 50ms and every order submitted
            within a window clears together, so a burst of activity doesn't
            advantage whoever's closer to the node.
          </p>

          <h3
            id="order-sequencing"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Order sequencing
          </h3>
          <p className="leading-relaxed mb-4">
            Makers can update quotes knowing they won't be picked off by takers
            arriving in the same window. Inside a batch, orders run in a fixed
            sequence: cancels first, then limits, then markets.
          </p>
          <Link
            to="/exchange"
            className="block border rounded-lg overflow-hidden hover:border-foreground/40 transition-colors my-4"
          >
            {/* TODO: replace with a screenshot of a batch containing a cancel and a market order */}
            <img
              src="/order-sequencing-preview.png"
              alt="Batch containing a cancel and a market order"
              className="w-full block bg-zinc-100"
              style={{ aspectRatio: "16 / 9", objectFit: "cover" }}
            />
            <div className="px-4 py-3 border-t flex items-center justify-between">
              <span className="text-sm font-semibold">See a live batch</span>
              <span className="text-sm text-foreground hover:underline decoration-1 underline-offset-2">/exchange →</span>
            </div>
          </Link>

          <h3
            id="pro-rata"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Pro-rata matching
          </h3>
          <p className="leading-relaxed">
            Every resting order at a tick fills at the same rate, regardless of
            when it arrived. Large orders earn their share of the fill
            proportionally, so posting size is rewarded. This also makes
            matching O(ticks), not O(orders), so gas scales with price levels
            rather than the number of makers.
          </p>

          {/* <h3
            id="force-inclusion"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Force inclusion
          </h3>
          <p className="leading-relaxed mb-4">
            The server is a privileged submitter: it chooses batch composition
            and submits from its own EOA. If it stalls or censors, any address
            can submit a signed mutation directly to the contract. The
            signature check is identical, so a force-included order settles
            under the same rules as a server-submitted one.
          </p> */}
        </section>

        {/* Architecture */}
        <section>
          <h2
            id="architecture"
            className="text-2xl font-bold mb-4 scroll-mt-24"
          >
            System Architecture
          </h2>
          <p className="leading-relaxed mb-4">
            Transactions don't hit the chain directly. Every signed mutation
            goes through a server that verifies the signature, runs it through
            REVM against local state, and replies{" "}
            <InlineCode>accepted</InlineCode> the moment it knows the
            transaction will succeed onchain.
          </p>
          <div className="my-6 flex justify-center">
            <img
              src={architectureDiagram}
              alt="Architecture sequence diagram: client signs, server bundles and submits, Monad confirms"
              className="w-3/4 h-auto"
            />
          </div>
          {/* <p className="leading-relaxed mb-4">
            The contract locks bundle submission to a single{" "}
            <InlineCode>scheduler</InlineCode> address that the server controls.
            No other party can submit through the normal path; users can still
            exit via force inclusion if the server misbehaves.
          </p>
          <CodeBlock
            title="Exchange.sol"
            lang="solidity"
            code={`address internal immutable SCHEDULER;

constructor(address _scheduler) {
    SCHEDULER = _scheduler;
}

function execute(Bundle[] calldata bundles) external {
    if (msg.sender != SCHEDULER) revert Unauthorized();
    // ...
}`}
          />

          <p className="leading-relaxed mb-4">
            Every mutation moves through an explicit lifecycle as it travels
            from the server to the chain.
          </p> */}

          <h3
            id="order-lifecycle"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Order lifecycle
          </h3>
          <p className="leading-relaxed mb-4">
            Every transaction moves through six states. The first two happen on
            the server in milliseconds; the rest unfold onchain as blocks and
            confirmations arrive.
          </p>
          <div className="my-4">
            <p className="text-sm font-semibold text-emerald-600 mb-4">
              * server response issued here
            </p>
            <div
              className="ml-14 flex flex-col items-center w-px"
              aria-hidden="true"
            >
              <div className="border-l border-border h-8" />
              <div className="leading-none text-xs -mt-[0.25em]">▼</div>
            </div>
            {[
              {
                state: "pending",
                trigger: "received by the server",
                toNext: "<50 ms",
              },
              {
                state: "accepted",
                trigger: "included in a batch, executed on the server via REVM",
                toNext: "<400 ms",
              },
              {
                state: "proposed",
                trigger: "included in a block, executed onchain",
                toNext: "~400 ms",
              },
              {
                state: "voted",
                trigger: "1 validator confirmation",
                toNext: "~400 ms",
              },
              {
                state: "finalized",
                trigger: "2 validator confirmations",
                toNext: "~1200 ms",
              },
              {
                state: "verified",
                trigger: "5+ validator confirmations",
              },
            ].map((step, i, arr) => {
              const isTerminal = i === arr.length - 1;
              const isAccepted = step.state === "accepted";
              const badgeClass = isTerminal
                ? "w-28 shrink-0 px-3 py-1.5 rounded-full text-sm font-medium text-center bg-foreground text-background"
                : isAccepted
                  ? "w-28 shrink-0 px-3 py-1.5 border border-border rounded-full text-sm font-medium text-center bg-background ring-2 ring-emerald-500 ring-offset-2"
                  : "w-28 shrink-0 px-3 py-1.5 border border-border rounded-full text-sm font-medium text-center bg-background";
              return (
                <div key={step.state}>
                  <div className="flex items-center gap-4">
                    <div className={badgeClass}>{step.state}</div>
                    <div className="text-sm leading-relaxed flex-1">
                      {step.trigger}
                    </div>
                  </div>
                  {!isTerminal && (
                    <div className="flex items-center gap-3">
                      <div
                        className="ml-14 flex flex-col items-center w-px"
                        aria-hidden="true"
                      >
                        <div className="border-l border-border h-8" />
                        <div className="leading-none text-xs -mt-[0.25em]">
                          ▼
                        </div>
                      </div>
                      <div className="text-xs text-zinc-500 ml-4">
                        {step.toNext}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Deployment */}
        <section>
          <h2 id="deployment" className="text-2xl font-bold mb-4 scroll-mt-24">
            Deployment
          </h2>
          <table className="w-full text-sm border border-border mb-4">
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2 font-semibold w-32">Chain</td>
                <td className="px-3 py-2">
                  {CHAIN_NAME} (id {CHAIN_ID})
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2 font-semibold">Exchange</td>
                <td className="px-3 py-2 break-all">
                  <a
                    href={`https://testnet.monadscan.com/address/${EXCHANGE_ADDRESS}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground hover:underline decoration-1 underline-offset-2"
                  >
                    {EXCHANGE_ADDRESS}
                  </a>
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2 font-semibold">API</td>
                <td className="px-3 py-2 break-all">
                  <a
                    href={apiUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground hover:underline decoration-1 underline-offset-2"
                  >
                    {apiUrl}
                  </a>
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-semibold">Source</td>
                <td className="px-3 py-2">
                  <a
                    href="https://github.com/monad-developers/tx-lifecycle-demo-app"
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground hover:underline decoration-1 underline-offset-2"
                  >
                    github.com/monad-developers/tx-lifecycle-demo-app
                  </a>
                </td>
              </tr>
            </tbody>
          </table>

          <h3
            id="instruments"
            className="text-lg font-semibold mt-6 mb-2 scroll-mt-24"
          >
            Instruments
          </h3>
          <p className="leading-relaxed mb-4">
            Instrument creation is permissionless;{" "}
            <Link to="/exchange" className="text-foreground hover:underline decoration-1 underline-offset-2">
              /exchange
            </Link>{" "}
            displays a curated subset.
          </p>
          <table className="w-full text-sm border border-border">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Pair</th>
                <th className="px-3 py-2">Base lot</th>
                <th className="px-3 py-2">Quote lot</th>
                <th className="px-3 py-2">Tick size</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">0</td>
                <td className="px-3 py-2 font-semibold">GOLD/USD</td>
                <td className="px-3 py-2">0.0000000343597 GOLD</td>
                <td className="px-3 py-2">$0.0000703687</td>
                <td className="px-3 py-2">$0.000000476837</td>
              </tr>
              <tr>
                <td className="px-3 py-2">1</td>
                <td className="px-3 py-2 font-semibold">WTIOIL/USD</td>
                <td className="px-3 py-2">0.00000109951 WTIOIL</td>
                <td className="px-3 py-2">$0.0000703687</td>
                <td className="px-3 py-2">$0.0000000149012</td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
