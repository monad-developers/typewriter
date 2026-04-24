import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center text-sm font-medium transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40",
  {
    variants: {
      variant: {
        solid:
          "bg-foreground text-background border border-foreground hover:bg-foreground/90 shadow-sm",
        primary:
          "bg-indigo-600 text-white border border-indigo-600 hover:bg-indigo-700 shadow-sm",
        outline:
          "bg-background border border-border hover:bg-muted/60 hover:border-foreground/30",
        ghost: "border border-transparent hover:bg-muted",
        link: "border-transparent text-indigo-600 hover:text-indigo-700 underline underline-offset-4 p-0 h-auto",
      },
      size: {
        sm: "h-7 px-2.5 rounded-md text-xs",
        md: "h-8 px-3 rounded-md",
        lg: "h-10 px-4 rounded-md",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
