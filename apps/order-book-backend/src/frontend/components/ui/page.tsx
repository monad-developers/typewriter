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

export function PageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-6xl mx-auto px-8 py-10 flex flex-col gap-10">
      {children}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {title !== undefined ? (
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="text-sm text-muted-foreground mt-1">
                {description}
              </p>
            ) : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border border-border rounded-xl bg-background overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
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
    <div className="flex items-baseline gap-4 text-[15px]">
      <span className="text-muted-foreground w-32 shrink-0 text-sm">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 break-all",
          mono && "font-mono tabular-nums text-sm",
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
  subtitle,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div>
      {eyebrow ? (
        <div className="text-sm text-muted-foreground mb-2">{eyebrow}</div>
      ) : null}
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {subtitle ? (
        <p className="text-base text-muted-foreground mt-2">{subtitle}</p>
      ) : null}
    </div>
  );
}
