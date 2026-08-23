"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import type { GalaxyPosition } from "./portfolio-galaxy-scene";

// Re-export for consumers
export type { GalaxyPosition };

const PortfolioGalaxyScene = dynamic(
  () => import("./portfolio-galaxy-scene").then((m) => ({ default: m.PortfolioGalaxyScene })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex items-center justify-center"
        style={{ height: 400 }}
      >
        <div className="h-32 w-32 animate-pulse rounded-full bg-[var(--color-surface)]" />
      </div>
    ),
  },
);

export interface PortfolioGalaxyProps {
  positions: GalaxyPosition[];
  height?: number;
  className?: string;
}

/**
 * PortfolioGalaxy — 3D particle system visualizing portfolio positions.
 * Each particle: size = position size, color = P&L sign.
 * Used on the India Portfolio Optimizer page as an optional visualization tab.
 * Dynamically imported with ssr: false to keep Three.js out of initial bundle.
 */
export function PortfolioGalaxy({ positions, height = 400, className }: PortfolioGalaxyProps) {
  return (
    <div className={cn("w-full overflow-hidden rounded-xl", className)}>
      <PortfolioGalaxyScene positions={positions} height={height} />
    </div>
  );
}
