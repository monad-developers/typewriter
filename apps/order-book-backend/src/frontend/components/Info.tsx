import type { ReactNode } from "react";

export function Info({
  title = "Note",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="border-l-2 border-black pl-4 my-4">
      <div className="text-xs uppercase tracking-wider font-semibold mb-1 text-zinc-500">
        {title}
      </div>
      <div className="leading-relaxed text-sm">{children}</div>
    </aside>
  );
}
