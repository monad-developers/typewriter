import {
  MutationLifecycle,
  type StageTimestamps,
} from "../components/MutationLifecycle";
import { MarketOrderFills, MutationParams } from "../components/MutationParams";
import { useAccount } from "../hooks/useAccount";
import { useMutation, useMutationByNonce } from "../hooks/useMutation";
import type { ApiMutation } from "../hooks/useMutations";
import { Link, useMatch } from "../lib/router";

const KEY_TYPE_LABELS = ["P256", "WebAuthnP256", "Secp256k1"] as const;

function stageTimestamps(mutation: ApiMutation): StageTimestamps {
  const out: StageTimestamps = {};
  out.pending = mutation.pendingAt;
  if (mutation.acceptedAt) out.accepted = mutation.acceptedAt;
  if (mutation.proposedAt) out.proposed = mutation.proposedAt;
  if (mutation.votedAt) out.voted = mutation.votedAt;
  if (mutation.finalizedAt) out.finalized = mutation.finalizedAt;
  if (mutation.verifiedAt) out.verified = mutation.verifiedAt;
  return out;
}

const linkClass = "text-blue-500 hover:underline";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function computeRequiresNonce(nonce: string): string | null {
  const n = BigInt(nonce);
  const seq = n & ((1n << 64n) - 1n);
  if (seq === 0n) return null;
  const nonceKey = n >> 64n;
  return ((nonceKey << 64n) | (seq - 1n)).toString();
}

export function MutationPage() {
  const match = useMatch<"id">("/mutation/:id");
  const id = match?.params.id;
  const query = useMutation(id);

  const mutation = query.data;

  const timestamps = mutation ? stageTimestamps(mutation) : undefined;

  const requiresNonce = mutation?.nonce ? computeRequiresNonce(mutation.nonce) : null;
  const requires = useMutationByNonce(
    mutation?.account,
    requiresNonce ?? undefined,
  );

  const account = useAccount(mutation?.account);
  const keyType =
    mutation && mutation.keyIndex != null && account.data
      ? (account.data.keys[Number(mutation.keyIndex)]?.keyType ?? null)
      : null;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <section className="w-full border-b p-4 flex flex-col gap-2">
        <h2 className="text-2xl font-bold">Message</h2>
        <code>id: {mutation?.id ?? "..."}</code>
        <code>batch: {mutation?.bundleId ?? "..."}</code>
        <code>
          block:{" "}
          {mutation?.blockNumber ? (
            <Link
              to={`/block/${mutation.blockNumber}`}
              className={linkClass}
            >
              {mutation.blockNumber}
            </Link>
          ) : (
            "..."
          )}
        </code>
      </section>

      <section className="w-full border-b p-4">
        <h2 className="text-2xl font-bold mb-4">Lifecycle</h2>
        <MutationLifecycle
          status={mutation?.status}
          timestamps={timestamps}
        />
      </section>

      <div className="w-full border-b flex flex-col md:flex-row">
        <section className="flex-1 p-4 flex flex-col gap-2 md:border-r border-b md:border-b-0">
          <h2 className="text-2xl font-bold mb-2">Parameters</h2>
          <code>type: {mutation?.type ?? "..."}</code>
          {mutation ? <MutationParams mutation={mutation} /> : null}
        </section>

        {mutation?.type === "marketOrder" ? (
          <section className="flex-1 p-4 flex flex-col gap-2 md:border-r border-b md:border-b-0">
            <h2 className="text-2xl font-bold mb-2">Resolution</h2>
            <MarketOrderFills mutation={mutation} />
          </section>
        ) : null}

        <section className="flex-1 p-4 flex flex-col gap-2">
          <h2 className="text-2xl font-bold mb-2">Signature</h2>
          <code>
            account:{" "}
            {mutation ? (
              <Link
                to={`/account/${mutation.accountSerial ?? mutation.account}`}
                className={linkClass}
              >
                {mutation.accountSerial != null
                  ? mutation.accountSerial
                  : shortAddr(mutation.account)}
              </Link>
            ) : (
              "..."
            )}
          </code>
          <code>
            requires:{" "}
            {mutation == null ? (
              "..."
            ) : requiresNonce == null ? (
              "none"
            ) : requires.data ? (
              <Link to={`/mutation/${requires.data.id}`} className={linkClass}>
                {requires.data.id}
              </Link>
            ) : (
              "..."
            )}
          </code>
          <code>
            type:{" "}
            {mutation == null
              ? "..."
              : mutation.keyIndex == null
                ? "root"
                : keyType != null
                  ? KEY_TYPE_LABELS[keyType]
                  : "..."}
          </code>
        </section>
      </div>

      <section className="w-full p-4 flex flex-col gap-2">
        <h2 className="text-2xl font-bold mb-2">State changes</h2>
        <code className="text-muted-foreground">coming soon</code>
      </section>
    </div>
  );
}
