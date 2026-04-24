import type { ReactNode } from "react";

export function Info({
  title = "Note",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="rounded-xl bg-muted/50 px-5 py-4 my-4 border border-border/60">
      <div className="text-xs font-medium mb-1 text-muted-foreground">
        {title}
      </div>
      <div className="leading-relaxed text-[15px] text-foreground/90">
        {children}
      </div>
    </aside>
  );
}
