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
    <div
      className={cn(
        "border border-border rounded-xl overflow-hidden bg-background",
        className,
      )}
    >
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="text-xs text-muted-foreground bg-muted/30">
      {children}
    </thead>
  );
}

export function TR({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border last:border-b-0 hover:bg-muted/30 transition-colors",
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
        "text-left px-4 h-10 align-middle whitespace-nowrap font-medium",
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
        "px-4 h-12 align-middle whitespace-nowrap text-[15px]",
        mono && "font-mono tabular-nums text-sm",
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
        className="px-4 py-8 text-muted-foreground text-sm text-center"
      >
        {children}
      </td>
    </tr>
  );
}
