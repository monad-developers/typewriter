import {
  MutationLifecycle,
  type StageTimestamps,
} from "../components/MutationLifecycle";
import { MutationParams } from "../components/MutationParams";
import { useAccount } from "../hooks/useAccount";
import { useMutation } from "../hooks/useMutation";
import type { ApiMutation } from "../hooks/useMutations";
import { Link, useMatch } from "../lib/router";

const KEY_TYPE_LABELS = ["P256", "WebAuthnP256", "Secp256k1"] as const;

function stageTimestamps(mutation: ApiMutation): StageTimestamps {
  const out: StageTimestamps = {};
  if (mutation.acceptedAt) out.accepted = mutation.acceptedAt.toISOString();
  if (mutation.includedAt) out.included = mutation.includedAt.toISOString();
  if (mutation.safeAt) out.safe = mutation.safeAt.toISOString();
  if (mutation.finalizedAt) out.finalized = mutation.finalizedAt.toISOString();
  return out;
}

const linkClass = "text-blue-500 hover:underline";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function mutationKind(mutation: ApiMutation | undefined) {
  if (mutation === undefined) return "...";
  if (mutation.rootKeyType !== undefined) return "initialize";
  if (mutation.keyType !== undefined && mutation.publicKey !== undefined)
    return "authorize";
  if (mutation.keyId !== undefined) return "revoke";
  if (mutation.orderId !== undefined && mutation.price !== undefined)
    return "changeOrder";
  if (mutation.orderId !== undefined) return "closeOrder";
  if (mutation.quantity !== undefined && mutation.price !== undefined)
    return "limitOrder";
  if (
    mutation.quantity !== undefined &&
    mutation.minReceivedQuantity !== undefined
  )
    return "marketOrder";
  if (mutation.base !== undefined && mutation.quote !== undefined)
    return "addInstrument";
  if (mutation.asset !== undefined && mutation.amount !== undefined)
    return "assetMovement";
  return "unknown";
}

export function MutationPage() {
  const match = useMatch<"id">("/mutation/:id");
  const id = match?.params.id;
  const query = useMutation(id);

  const mutation = query.data;

  const timestamps = mutation ? stageTimestamps(mutation) : undefined;

  const account = useAccount(mutation?.signature_account);
  const keyType =
    mutation && account.data
      ? (account.data.keys[Number(mutation.signature_keyId)]?.keyType ?? null)
      : null;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <section className="w-full border-b p-4 flex flex-col gap-2">
        <h2 className="text-2xl font-bold">Message</h2>
        <code>id: {mutation?.id ?? "..."}</code>
        <code>
          execution index: {mutation?.executionIndex?.toString() ?? "..."}
        </code>
        <code>
          block:{" "}
          {mutation?.blockNumber != null ? (
            <Link to={`/block/${mutation.blockNumber}`} className={linkClass}>
              {mutation.blockNumber.toString()}
            </Link>
          ) : (
            "..."
          )}
        </code>
      </section>

      <section className="w-full border-b p-4">
        <h2 className="text-2xl font-bold mb-4">Lifecycle</h2>
        <MutationLifecycle status={mutation?.status} timestamps={timestamps} />
      </section>

      <div className="w-full border-b flex flex-col md:flex-row">
        <section className="flex-1 p-4 flex flex-col gap-2 md:border-r border-b md:border-b-0">
          <h2 className="text-2xl font-bold mb-2">Parameters</h2>
          <code>type: {mutationKind(mutation)}</code>
          {mutation ? <MutationParams mutation={mutation} /> : null}
        </section>

        <section className="flex-1 min-w-0 p-4 flex flex-col gap-2">
          <h2 className="text-2xl font-bold mb-2">Signature</h2>
          <code>
            account:{" "}
            {mutation ? (
              <Link
                to={`/account/${mutation.signature_account}`}
                className={linkClass}
              >
                {shortAddr(mutation.signature_account)}
              </Link>
            ) : (
              "..."
            )}
          </code>
          <code>
            type:{" "}
            {mutation == null
              ? "..."
              : mutation.signature_keyId === 0n
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
