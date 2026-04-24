import type { ReactNode } from "react";

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-muted text-foreground text-[0.85em] font-mono border border-border">
      {children}
    </code>
  );
}
