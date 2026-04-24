import type { ReactNode } from "react";

export function Info({
  title = "note",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="border border-sky-200 border-l-2 border-l-sky-500 bg-sky-50/60 rounded-[3px] px-4 py-3 my-4">
      <div className="text-[11px] uppercase tracking-[0.14em] font-semibold mb-1 text-sky-800">
        {title}
      </div>
      <div className="leading-relaxed text-sm text-foreground/90">{children}</div>
    </aside>
  );
}
