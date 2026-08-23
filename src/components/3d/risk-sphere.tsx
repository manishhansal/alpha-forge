"use client";

/**
 * RiskSphere
 *
 * A GPU-efficient R3F sphere that visually encodes portfolio risk (0–100)
 * through color, scale, and opacity.
 *
 * Visual encoding:
 *   color   → risk tier (green 0–33, yellow 33–66, red 66–100)
 *   scale   → 0.7 + (riskLevel / 100) * 0.5  (0.7 at zero risk, 1.2 at max)
 *   opacity → 0.5 + (riskLevel / 100) * 0.4
 *
 * Dynamically imports the R3F scene with ssr: false so Three.js is never
 * included in the server bundle.
 */

import * as React from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";

/* ── Public props ────────────────────────────────────────────────────────── */

export interface RiskSphereProps {
  /** Portfolio risk level, clamped to [0, 100]. */
  riskLevel: number;
  /** Canvas height and width in px. Defaults to 120. */
  size?: number;
  className?: string;
}

/* ── Loading skeleton ────────────────────────────────────────────────────── */

function RiskSphereSkeleton() {
  return (
    <div
      className="animate-pulse rounded-full"
      style={{
        width: 120,
        height: 120,
        backgroundColor: "var(--color-surface, var(--color-panel-bg, #1e1e2e))",
      }}
      aria-hidden="true"
    />
  );
}

/* ── Dynamic R3F scene import — keeps Three.js out of initial bundle ─────── */

const RiskSphereScene = dynamic(
  () =>
    import("./risk-sphere-scene").then((m) => ({ default: m.RiskSphereScene })),
  {
    ssr: false,
    loading: () => <RiskSphereSkeleton />,
  },
);

/* ── Public component ────────────────────────────────────────────────────── */

export function RiskSphere({ riskLevel, size = 120, className }: RiskSphereProps) {
  const clamped = Math.max(0, Math.min(100, riskLevel));

  return (
    <div
      className={cn("flex items-center justify-center", className)}
      aria-hidden
    >
      <RiskSphereScene riskLevel={clamped} size={size} />
    </div>
  );
}
