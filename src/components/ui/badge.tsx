import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide ring-1 ring-inset",
  {
    variants: {
      variant: {
        neutral:
          "bg-[color-mix(in_oklch,var(--color-neutral)_12%,transparent)] text-[var(--color-fg-muted)] ring-[var(--color-border)]",
        bull:
          "bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]",
        bear:
          "bg-[color-mix(in_oklch,var(--color-bear)_15%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]",
        warning:
          "bg-[color-mix(in_oklch,var(--color-warning)_15%,transparent)] text-[var(--color-warning)] ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]",
        info:
          "bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)] ring-[color-mix(in_oklch,var(--color-info)_30%,transparent)]",
        outline: "bg-transparent text-[var(--color-fg-muted)] ring-[var(--color-border)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
