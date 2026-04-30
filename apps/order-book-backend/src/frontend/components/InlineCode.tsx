import type { ReactNode } from "react";

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="px-1 bg-zinc-100 text-[0.9em]">{children}</code>;
}
