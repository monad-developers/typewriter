import {
  MutationLifecycle,
  type StageTimestamps,
} from "../components/MutationLifecycle";
import { MarketOrderFills, MutationParams } from "../components/MutationParams";
import {
  Card,
  Field,
  PageContainer,
  PageHeader,
  PageShell,
  Section,
} from "../components/ui/page";
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

const linkClass = "hover:underline decoration-1 underline-offset-2";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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
      <PageContainer>
        <div className="flex flex-col gap-5">
          <PageHeader eyebrow="Mutation" title={mutation?.id ?? "…"} />
          <div className="flex flex-col gap-2">
            <Field label="Bundle" mono>
              {mutation?.bundleId ?? "…"}
            </Field>
            <Field label="Block" mono>
              {mutation?.blockNumber ? (
                <Link
                  to={`/block/${mutation.blockNumber}`}
                  className={linkClass}
                >
                  {mutation.blockNumber}
                </Link>
              ) : (
                "…"
              )}
            </Field>
          </div>
        </div>

        <Section title="Lifecycle">
          <Card className="p-6">
            <MutationLifecycle
              status={mutation?.status}
              timestamps={timestamps}
            />
          </Card>
        </Section>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-6 flex flex-col gap-3">
            <h3 className="text-base font-semibold tracking-tight mb-1">
              Parameters
            </h3>
            <Field label="Type">
              <span className="font-medium">{mutation?.type ?? "…"}</span>
            </Field>
            {mutation ? <MutationParams mutation={mutation} /> : null}
          </Card>

          {mutation?.type === "marketOrder" ? (
            <Card className="p-6 flex flex-col gap-3">
              <h3 className="text-base font-semibold tracking-tight mb-1">
                Resolution
              </h3>
              <MarketOrderFills mutation={mutation} />
            </Card>
          ) : null}

          <Card className="p-6 flex flex-col gap-3">
            <h3 className="text-base font-semibold tracking-tight mb-1">
              Signature
            </h3>
            <Field label="Account" mono>
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
            <Field label="Requires" mono>
              {mutation == null ? (
                "…"
              ) : requiresNonce == null ? (
                <span className="text-muted-foreground">none</span>
              ) : requires.data ? (
                <Link
                  to={`/mutation/${requires.data.id}`}
                  className={linkClass}
                >
                  {requires.data.id}
                </Link>
              ) : (
                "…"
              )}
            </Field>
            <Field label="Key">
              {mutation == null
                ? "…"
                : mutation.keyIndex == null
                  ? "root"
                  : keyType != null
                    ? KEY_TYPE_LABELS[keyType]
                    : "…"}
            </Field>
          </Card>
        </div>

        <Section title="State changes">
          <Card className="p-6">
            <div className="text-muted-foreground text-sm">coming soon</div>
          </Card>
        </Section>
      </PageContainer>
    </PageShell>
  );
}
