import { forwardRef, type LabelHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-muted)]",
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = "Label";
