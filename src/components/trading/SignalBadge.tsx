"use client";

import * as React from "react";
import { TrendingUp, TrendingDown, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type AiAction = "LONG" | "SHORT" | "BUY" | "SELL" | "WAIT";

export interface SignalBadgeProps {
  action: AiAction;
  size?: "sm" | "md" | "lg";
  showIcon?: boolean;
  className?: string;
}

const SIZE_CLASSES = {
  sm: "px-1.5 py-0.5 text-[10px] gap-1",
  md: "px-2 py-1 text-xs gap-1.5",
  lg: "px-3 py-1.5 text-sm gap-2",
} as const;

const ICON_SIZES = { sm: 10, md: 12, lg: 14 } as const;

export function SignalBadge({
  action,
  size = "md",
  showIcon = true,
  className,
}: SignalBadgeProps) {
  const isPositive = action === "LONG" || action === "BUY";
  const isNegative = action === "SHORT" || action === "SELL";
  const isNeutral = action === "WAIT";

  const Icon = isPositive ? TrendingUp : isNegative ? TrendingDown : Clock;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded font-semibold uppercase tracking-wider font-mono",
        SIZE_CLASSES[size],
        className,
      )}
      style={{
        color: isPositive
          ? "var(--color-data-positive)"
          : isNegative
          ? "var(--color-data-negative)"
          : "var(--color-fg-muted)",
        backgroundColor: isPositive
          ? "color-mix(in oklch, var(--data-positive) 12%, transparent)"
          : isNegative
          ? "color-mix(in oklch, var(--data-negative) 12%, transparent)"
          : "color-mix(in oklch, var(--fg-muted) 10%, transparent)",
        border: `1px solid ${
          isPositive
            ? "color-mix(in oklch, var(--data-positive) 28%, transparent)"
            : isNegative
            ? "color-mix(in oklch, var(--data-negative) 28%, transparent)"
            : "color-mix(in oklch, var(--fg-muted) 20%, transparent)"
        }`,
      }}
    >
      {showIcon && <Icon size={ICON_SIZES[size]} aria-hidden="true" />}
      {action}
    </span>
  );
}
