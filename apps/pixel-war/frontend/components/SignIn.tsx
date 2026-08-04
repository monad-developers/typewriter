import { useSignIn } from "../hooks/useSignIn";
import { useSignUp } from "../hooks/useSignUp";

export function SignIn() {
  const signUp = useSignUp();
  const signIn = useSignIn();
  const error = signUp.error ?? signIn.error;

  return (
    <div className="flex flex-col gap-3 border border-edge bg-panel p-4">
      <div className="text-sm">Join the war</div>
      <p className="text-xs leading-relaxed text-dim">
        One tap creates a passkey and an in-browser session key. You are
        assigned to the smallest team. No wallet, no seed phrase, no gas — the
        server pays for settlement while you sign the mutations.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => signUp.mutate()}
          disabled={signUp.isPending}
          className="flex-1 border border-ink px-3 py-2 text-xs uppercase tracking-wide hover:bg-panel disabled:opacity-50"
        >
          {signUp.isPending ? "creating…" : "new player"}
        </button>
        <button
          type="button"
          onClick={() => signIn.mutate()}
          disabled={signIn.isPending}
          className="flex-1 border border-edge px-3 py-2 text-xs uppercase tracking-wide hover:border-dim disabled:opacity-50"
        >
          {signIn.isPending ? "signing in…" : "i have a passkey"}
        </button>
      </div>
      {error !== null && (
        <div className="text-xs text-red-400">
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}
    </div>
  );
}
