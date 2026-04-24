import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center font-mono text-sm border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
  {
    variants: {
      variant: {
        solid: "bg-foreground text-background border-foreground hover:bg-foreground/90",
        outline: "bg-background border-border hover:bg-muted",
        ghost: "border-transparent hover:bg-muted",
        link: "border-transparent text-sky-700 hover:underline underline-offset-2 p-0 h-auto",
      },
      size: {
        sm: "h-7 px-2.5 rounded-[3px]",
        md: "h-8 px-3 rounded-[3px]",
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
