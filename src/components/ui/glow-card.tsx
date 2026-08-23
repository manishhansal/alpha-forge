"use client";

/**
 * GlowCard — 3D-tilt glass card with neon border glow on hover.
 * StatCard  — compact metric card (value + delta + label + icon).
 * NeonBadge — inline status badge with glowing border.
 *
 * All primitives are fully theme-aware via CSS custom properties and
 * require zero configuration — drop them anywhere in the dashboard.
 */

import * as React from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type HTMLMotionProps,
} from "framer-motion";
import { cn } from "@/lib/utils";

/* ─── GlowCard ──────────────────────────────────────────────────────────── */

export interface GlowCardProps extends HTMLMotionProps<"div"> {
  /** Accent color key that drives the glow. Defaults to "brand". */
  accent?: "brand" | "bull" | "bear" | "info" | "warning" | "none";
  /** Max rotation in degrees for the 3D tilt. Defaults to 8. */
  tiltMax?: number;
  /** Disable 3D tilt (useful for cards that contain interactive children). */
  noTilt?: boolean;
  children: React.ReactNode;
}

const ACCENT_GLOW: Record<NonNullable<GlowCardProps["accent"]>, string> = {
  brand:   "var(--glow-brand)",
  bull:    "var(--glow-bull)",
  bear:    "var(--glow-bear)",
  info:    "var(--glow-info)",
  warning: "color-mix(in oklch, var(--warning) 22%, transparent)",
  none:    "transparent",
};

const ACCENT_RING: Record<NonNullable<GlowCardProps["accent"]>, string> = {
  brand:   "color-mix(in oklch, var(--brand) 30%, transparent)",
  bull:    "color-mix(in oklch, var(--bull)  28%, transparent)",
  bear:    "color-mix(in oklch, var(--bear)  28%, transparent)",
  info:    "color-mix(in oklch, var(--info)  25%, transparent)",
  warning: "color-mix(in oklch, var(--warning) 25%, transparent)",
  none:    "transparent",
};

export const GlowCard = React.forwardRef<HTMLDivElement, GlowCardProps>(
  function GlowCard(
    {
      accent = "brand",
      tiltMax = 8,
      noTilt = false,
      className,
      children,
      style,
      onMouseMove,
      onMouseLeave,
      ...rest
    },
    ref,
  ) {
    const mx = useMotionValue(0);
    const my = useMotionValue(0);

    const springCfg = { stiffness: 220, damping: 20 };
    const rotX = useSpring(useTransform(my, [-60, 60], [tiltMax, -tiltMax]), springCfg);
    const rotY = useSpring(useTransform(mx, [-60, 60], [-tiltMax, tiltMax]), springCfg);

    const handleMouseMove = React.useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!noTilt) {
          const rect = e.currentTarget.getBoundingClientRect();
          mx.set(e.clientX - rect.left - rect.width  / 2);
          my.set(e.clientY - rect.top  - rect.height / 2);
        }
        onMouseMove?.(e);
      },
      [mx, my, noTilt, onMouseMove],
    );

    const handleMouseLeave = React.useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!noTilt) { mx.set(0); my.set(0); }
        onMouseLeave?.(e);
      },
      [mx, my, noTilt, onMouseLeave],
    );

    const glow = ACCENT_GLOW[accent];
    const ring = ACCENT_RING[accent];

    return (
      <motion.div
        ref={ref}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={
          {
            "--card-glow": glow,
            "--card-ring": ring,
            rotateX: noTilt ? 0 : rotX,
            rotateY: noTilt ? 0 : rotY,
            transformStyle: "preserve-3d",
            ...style,
          } as React.CSSProperties
        }
        whileHover={accent !== "none" ? { scale: 1.012 } : undefined}
        transition={{ scale: { duration: 0.2 } }}
        className={cn(
          "relative overflow-hidden rounded-2xl",
          "glass holo-card",
          "transition-[box-shadow,border-color] duration-300",
          "hover:[box-shadow:0_0_0_1px_var(--card-ring),0_20px_56px_-16px_var(--card-glow),0_0_32px_-8px_var(--card-glow)]",
          className,
        )}
        {...rest}
      >
        {/* Inner depth layer */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ transform: "translateZ(0px)" }}
        />
        {/* Content lifted above */}
        <div style={{ transform: "translateZ(12px)" }} className="relative">
          {children}
        </div>
      </motion.div>
    );
  },
);

/* ─── StatCard ──────────────────────────────────────────────────────────── */

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** E.g. "+2.4%" — shown below value with bull/bear coloring. */
  delta?: string | null;
  /** Positive = green, negative = red, null = auto-detect from delta sign. */
  deltaPositive?: boolean | null;
  /** Icon component (lucide or custom). */
  icon?: React.ComponentType<{ className?: string }>;
  /** Accent drives the icon bg gradient. */
  accent?: GlowCardProps["accent"];
  className?: string;
  tiltMax?: number;
}

export function StatCard({
  label,
  value,
  delta,
  deltaPositive,
  icon: Icon,
  accent = "brand",
  className,
  tiltMax = 6,
}: StatCardProps) {
  const isUp =
    deltaPositive !== null && deltaPositive !== undefined
      ? deltaPositive
      : delta
        ? !delta.startsWith("-")
        : null;

  const ICON_GRADIENT: Record<NonNullable<GlowCardProps["accent"]>, string> = {
    brand:   "from-[color-mix(in_oklch,var(--brand)_30%,transparent)] to-[color-mix(in_oklch,var(--info)_20%,transparent)]",
    bull:    "from-[color-mix(in_oklch,var(--bull)_30%,transparent)] to-[color-mix(in_oklch,var(--bull)_10%,transparent)]",
    bear:    "from-[color-mix(in_oklch,var(--bear)_30%,transparent)] to-[color-mix(in_oklch,var(--bear)_10%,transparent)]",
    info:    "from-[color-mix(in_oklch,var(--info)_30%,transparent)] to-[color-mix(in_oklch,var(--brand)_10%,transparent)]",
    warning: "from-[color-mix(in_oklch,var(--warning)_30%,transparent)] to-[color-mix(in_oklch,var(--warning)_10%,transparent)]",
    none:    "from-[var(--color-surface)] to-[var(--color-surface)]",
  };

  const ICON_COLOR: Record<NonNullable<GlowCardProps["accent"]>, string> = {
    brand:   "text-[var(--color-brand)]",
    bull:    "text-[var(--color-bull)]",
    bear:    "text-[var(--color-bear)]",
    info:    "text-[var(--color-info)]",
    warning: "text-[var(--color-warning)]",
    none:    "text-[var(--color-fg-muted)]",
  };

  return (
    <GlowCard accent={accent} tiltMax={tiltMax} className={className}>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between">
          <span className="text-xs font-medium uppercase tracking-widest text-[var(--color-fg-subtle)]">
            {label}
          </span>
          {Icon && (
            <span
              className={cn(
                "grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br",
                ICON_GRADIENT[accent],
                ICON_COLOR[accent],
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
          )}
        </div>

        <div className="flex items-end justify-between gap-2">
          <div className="text-2xl font-bold tracking-tight text-[var(--color-fg)] num">
            {value}
          </div>
          {delta && (
            <span
              className={cn(
                "mb-0.5 rounded-md px-2 py-0.5 text-[11px] font-semibold num",
                isUp === true
                  ? "bg-[color-mix(in_oklch,var(--bull)_12%,transparent)] text-[var(--color-bull)]"
                  : isUp === false
                    ? "bg-[color-mix(in_oklch,var(--bear)_12%,transparent)] text-[var(--color-bear)]"
                    : "bg-[var(--color-surface)] text-[var(--color-fg-muted)]",
              )}
            >
              {delta}
            </span>
          )}
        </div>
      </div>
    </GlowCard>
  );
}

/* ─── NeonBadge ─────────────────────────────────────────────────────────── */

export type NeonBadgeVariant =
  | "brand" | "bull" | "bear" | "info" | "warning" | "neutral";

export interface NeonBadgeProps {
  children: React.ReactNode;
  variant?: NeonBadgeVariant;
  /** Show a pulsing live-dot prefix. */
  live?: boolean;
  className?: string;
}

const BADGE_STYLES: Record<NeonBadgeVariant, string> = {
  brand:   "border-[color-mix(in_oklch,var(--brand)_40%,transparent)] bg-[color-mix(in_oklch,var(--brand)_10%,transparent)] text-[var(--brand)] [box-shadow:0_0_10px_-2px_var(--glow-brand)]",
  bull:    "border-[color-mix(in_oklch,var(--bull)_38%,transparent)]  bg-[color-mix(in_oklch,var(--bull)_10%,transparent)]  text-[var(--bull)]  [box-shadow:0_0_8px_-2px_var(--glow-bull)]",
  bear:    "border-[color-mix(in_oklch,var(--bear)_38%,transparent)]  bg-[color-mix(in_oklch,var(--bear)_10%,transparent)]  text-[var(--bear)]  [box-shadow:0_0_8px_-2px_var(--glow-bear)]",
  info:    "border-[color-mix(in_oklch,var(--info)_35%,transparent)]  bg-[color-mix(in_oklch,var(--info)_10%,transparent)]  text-[var(--info)]  [box-shadow:0_0_8px_-2px_var(--glow-info)]",
  warning: "border-[color-mix(in_oklch,var(--warning)_35%,transparent)] bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] text-[var(--warning)]",
  neutral: "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]",
};

const LIVE_DOT_COLORS: Record<NeonBadgeVariant, string> = {
  brand:   "bg-[var(--brand)]",
  bull:    "bg-[var(--bull)]",
  bear:    "bg-[var(--bear)]",
  info:    "bg-[var(--info)]",
  warning: "bg-[var(--warning)]",
  neutral: "bg-[var(--color-fg-subtle)]",
};

export function NeonBadge({
  children,
  variant = "brand",
  live = false,
  className,
}: NeonBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
        BADGE_STYLES[variant],
        className,
      )}
    >
      {live && (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping",
              LIVE_DOT_COLORS[variant],
            )}
          />
          <span
            className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", LIVE_DOT_COLORS[variant])}
          />
        </span>
      )}
      {children}
    </span>
  );
}
