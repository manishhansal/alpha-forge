"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Circle } from "lucide-react";
import type { MarketRegime } from "@/store/uiStore";
import { SPRING_MICRO } from "@/lib/motion-presets";
import { cn } from "@/lib/utils";

export type RegimeLabel = MarketRegime;

export interface RegimeBadgeProps {
  regime: RegimeLabel;
  /** Default true — triggers SPRING_MICRO scale-in on mount */
  animate?: boolean;
  className?: string;
}

interface RegimeConfig {
  label: string;
  Icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  color: string;
  background: string;
}

const REGIME_CONFIG: Record<RegimeLabel, RegimeConfig> = {
  BULL: {
    label: "BULL",
    Icon: TrendingUp,
    color: "var(--color-data-positive)",
    background: "var(--color-regime-bull)",
  },
  BEAR: {
    label: "BEAR",
    Icon: TrendingDown,
    color: "var(--color-data-negative)",
    background: "var(--color-regime-bear)",
  },
  SIDEWAYS: {
    label: "SIDEWAYS",
    Icon: Minus,
    color: "var(--color-data-neutral)",
    background: "var(--color-regime-sideways)",
  },
  HIGH_VOL: {
    label: "HIGH VOL",
    Icon: AlertTriangle,
    color: "var(--color-warning)",
    background: "var(--color-regime-highvol)",
  },
  UNKNOWN: {
    label: "UNKNOWN",
    Icon: Circle,
    color: "var(--color-fg-muted)",
    background: "transparent",
  },
};

export function RegimeBadge({ regime, animate = true, className }: RegimeBadgeProps) {
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = animate && !prefersReducedMotion;

  const { label, Icon, color, background } = REGIME_CONFIG[regime] ?? REGIME_CONFIG.UNKNOWN;

  return (
    <motion.span
      initial={shouldAnimate ? { scale: 0.85, opacity: 0 } : false}
      animate={shouldAnimate ? { scale: 1, opacity: 1 } : undefined}
      transition={SPRING_MICRO}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wider font-mono",
        className,
      )}
      style={{ color, background }}
    >
      <Icon size={11} aria-hidden={true} />
      {label}
    </motion.span>
  );
}
