import type { ReactNode } from "react";

export function Tooltip({
  children,
  content,
}: {
  children: ReactNode;
  content: string;
}) {
  return (
    <div className="group/tooltip relative inline-flex">
      {children}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-1/2 bottom-full -translate-x-1/2 mb-2 px-2.5 py-1.5 text-xs rounded-md bg-primary text-primary-foreground whitespace-nowrap opacity-0 scale-95 transition-all group-hover/tooltip:opacity-100 group-hover/tooltip:scale-100 z-50"
      >
        {content}
        <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-primary" />
      </div>
    </div>
  );
}
