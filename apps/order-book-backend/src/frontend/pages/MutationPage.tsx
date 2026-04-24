import {
  MutationLifecycle,
  type StageTimestamps,
} from "../components/MutationLifecycle";
import { MarketOrderFills, MutationParams } from "../components/MutationParams";
import { Field, PageShell, Section } from "../components/ui/page";
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

const linkClass = "text-sky-700 hover:underline";

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
    <PageShell>
      <Section>
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-1">
          mutation
        </div>
        <div className="text-2xl font-semibold tabular-nums mb-4">
          {mutation?.id ?? "…"}
        </div>
        <div className="flex flex-col gap-1.5">
          <Field label="bundle">
            <span className="tabular-nums">{mutation?.bundleId ?? "…"}</span>
          </Field>
          <Field label="block">
            {mutation?.blockNumber ? (
              <Link
                to={`/block/${mutation.blockNumber}`}
                className={`${linkClass} tabular-nums`}
              >
                {mutation.blockNumber}
              </Link>
            ) : (
              "…"
            )}
          </Field>
        </div>
      </Section>

      <Section title="lifecycle">
        <MutationLifecycle
          status={mutation?.status}
          timestamps={timestamps}
        />
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border border-b border-border">
        <Section bordered={false} title="parameters">
          <div className="flex flex-col gap-1.5">
            <Field label="type">{mutation?.type ?? "…"}</Field>
            {mutation ? <MutationParams mutation={mutation} /> : null}
          </div>
        </Section>

        {mutation?.type === "marketOrder" ? (
          <Section bordered={false} title="resolution">
            <MarketOrderFills mutation={mutation} />
          </Section>
        ) : null}

        <Section bordered={false} title="signature">
          <div className="flex flex-col gap-1.5">
            <Field label="account">
              {mutation ? (
                <Link
                  to={`/account/${mutation.accountSerial ?? mutation.account}`}
                  className={linkClass}
                >
                  {mutation.accountSerial != null
                    ? `#${mutation.accountSerial}`
                    : shortAddr(mutation.account)}
                </Link>
              ) : (
                "…"
              )}
            </Field>
            <Field label="requires">
              {mutation == null ? (
                "…"
              ) : requiresNonce == null ? (
                <span className="text-muted-foreground">none</span>
              ) : requires.data ? (
                <Link to={`/mutation/${requires.data.id}`} className={linkClass}>
                  {requires.data.id}
                </Link>
              ) : (
                "…"
              )}
            </Field>
            <Field label="key">
              {mutation == null
                ? "…"
                : mutation.keyIndex == null
                  ? "root"
                  : keyType != null
                    ? KEY_TYPE_LABELS[keyType]
                    : "…"}
            </Field>
          </div>
        </Section>
      </div>

      <Section title="state changes" bordered={false}>
        <div className="text-muted-foreground text-sm italic">coming soon</div>
      </Section>
    </PageShell>
  );
}
