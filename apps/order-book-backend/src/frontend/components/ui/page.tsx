import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-screen w-full flex flex-col font-mono", className)}>
      {children}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
  bordered = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bordered?: boolean;
}) {
  return (
    <section
      className={cn(
        "px-6 py-5",
        bordered && "border-b border-border",
        className,
      )}
    >
      {title !== undefined ? (
        <div className="mb-3 flex items-center justify-between gap-4">
          <SectionHeader>{title}</SectionHeader>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-muted-foreground">
      {children}
    </h2>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}
