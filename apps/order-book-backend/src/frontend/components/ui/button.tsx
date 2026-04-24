import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center text-sm font-medium transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  {
    variants: {
      variant: {
        solid:
          "bg-foreground text-background hover:bg-foreground/90 shadow-sm hover:shadow-md",
        outline:
          "bg-background border border-border hover:bg-muted/60 hover:border-foreground/30",
        ghost: "hover:bg-muted",
        link: "text-foreground hover:text-foreground/70 underline underline-offset-4 decoration-1 p-0 h-auto",
      },
      size: {
        sm: "h-8 px-3 rounded-full",
        md: "h-9 px-4 rounded-full",
        lg: "h-11 px-6 rounded-full text-[15px]",
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
