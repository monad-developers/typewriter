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
    <div className={cn("min-h-screen w-full flex flex-col", className)}>
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
    <h2 className="text-[10px] uppercase tracking-[0.18em] font-bold text-muted-foreground">
      {children}
    </h2>
  );
}

export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-muted-foreground text-xs w-28 shrink-0 uppercase tracking-wider">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 break-all",
          mono && "font-mono tabular-nums text-[13px]",
        )}
      >
        {children}
      </span>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
}: {
  eyebrow: string;
  title: ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] font-bold text-muted-foreground mb-2">
        {eyebrow}
      </div>
      <h1 className="text-2xl font-semibold tracking-tight font-mono tabular-nums">
        {title}
      </h1>
    </div>
  );
}
