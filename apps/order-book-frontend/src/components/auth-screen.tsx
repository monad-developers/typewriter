"use client";

import { useDemoSignUp } from "~/hooks/use-demo-sign-up";
import { useSignUp } from "~/hooks/use-sign-up";
import { useSignIn } from "~/hooks/use-sign-in";

export function AuthScreen() {
  const signUp = useSignUp();
  const signIn = useSignIn();
  const demoSignUp = useDemoSignUp();
  const isPending =
    signUp.isPending || signIn.isPending || demoSignUp.isPending;
  const error = signUp.error || signIn.error || demoSignUp.error;

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col gap-3 items-center">
        <h2 className="text-lg font-medium text-foreground mb-2">
          Sign in to trade
        </h2>
        <button
          type="button"
          disabled={isPending}
          onClick={() => signUp.mutate()}
          className="px-6 py-2 border border-border rounded-md text-sm text-foreground bg-card hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed w-64 transition-colors"
        >
          {signUp.isPending
            ? "Creating account..."
            : "Create account with passkey"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => signIn.mutate()}
          className="px-6 py-2 border border-border rounded-md text-sm text-foreground bg-card hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed w-64 transition-colors"
        >
          {signIn.isPending ? "Signing in..." : "Sign in with passkey"}
        </button>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="h-px w-12 bg-border" />
          or
          <span className="h-px w-12 bg-border" />
        </div>
        <button
          type="button"
          disabled={isPending}
          onClick={() => demoSignUp.mutate()}
          className="px-6 py-2 border border-border rounded-md text-sm text-muted-foreground bg-card hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed w-64 transition-colors"
        >
          {demoSignUp.isPending ? "Creating demo account..." : "Demo sign up"}
        </button>
        {error && (
          <p className="text-sm text-destructive mt-2">
            {error instanceof Error ? error.message : "Something went wrong"}
          </p>
        )}
      </div>
    </div>
  );
}
