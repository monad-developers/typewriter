import type { ReactNode } from "react";

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-900 text-[0.9em] font-mono border border-zinc-200">
      {children}
    </code>
  );
}
