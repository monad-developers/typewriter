import type { ReactNode } from "react";

export function Info({
  title = "Note",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="border border-sky-200 border-l-4 border-l-sky-500 bg-sky-50 px-4 py-3 my-4">
      <div className="text-xs uppercase tracking-wider font-semibold mb-1 text-sky-700">
        {title}
      </div>
      <div className="leading-relaxed text-sm">{children}</div>
    </aside>
  );
}
