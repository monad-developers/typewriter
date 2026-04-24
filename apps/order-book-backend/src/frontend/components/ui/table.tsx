import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function DataTable({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border border-border rounded-md overflow-hidden bg-background", className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground bg-muted/40">
      {children}
    </thead>
  );
}

export function TR({
  children,
  className,
  zebra,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  zebra?: boolean;
} & React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border last:border-b-0",
        zebra && "even:bg-muted/30",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TH({
  children,
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th
      className={cn(
        "text-left px-3 h-8 align-middle whitespace-nowrap font-bold",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  mono,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & {
  children?: ReactNode;
  mono?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-3 h-9 align-middle whitespace-nowrap",
        mono && "font-mono tabular-nums text-[13px]",
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}

export function Empty({
  children,
  colSpan,
}: {
  children: ReactNode;
  colSpan: number;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-4 text-muted-foreground italic text-sm text-center"
      >
        {children}
      </td>
    </tr>
  );
}
