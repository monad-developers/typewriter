import type { ReactNode } from "react";

export function Info({
  title = "Note",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="border border-indigo-200 border-l-2 border-l-indigo-500 bg-indigo-50/50 rounded-md px-4 py-3 my-4">
      <div className="text-[10px] uppercase tracking-[0.18em] font-bold mb-1 text-indigo-700">
        {title}
      </div>
      <div className="leading-relaxed text-sm text-foreground/90">{children}</div>
    </aside>
  );
}
