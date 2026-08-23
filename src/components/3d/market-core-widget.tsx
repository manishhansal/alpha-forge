"use client";

/**
 * MarketCoreWidget
 *
 * Reads live data from the India market store and derives the four
 * MarketIntelligenceCore inputs:
 *
 *   regime    ← nifty bias API string mapped to MarketRegime enum
 *   volatility ← India VIX normalised 0–1 (range 10–40)
 *   breadth    ← fraction of indices + sectors that are positive
 *   vix        ← raw VIX value for rotation speed
 *
 * Dynamically imports MarketIntelligenceCore (Three.js ~600KB) so it is
 * never bundled into the initial page load.
 */

import dynamic from "next/dynamic";
import * as React from "react";

import { useIndiaMarketStore } from "@/store/india/marketStore";
import type { MarketRegime } from "./market-intelligence-core";

/* ── Dynamic import — keeps Three.js out of the initial bundle ─────────── */
const MarketCoreCard = dynamic(
  () =>
    import("./market-intelligence-core").then((m) => ({
      default: m.MarketCoreCard,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="glass rounded-2xl flex items-center justify-center" style={{ height: 280 }}>
        <div className="flex flex-col items-center gap-3">
          {/* Pulsing placeholder orb */}
          <div className="h-24 w-24 rounded-full bg-[color-mix(in_oklch,var(--color-brand)_12%,transparent)] animate-pulse" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Loading Core…
          </span>
        </div>
      </div>
    ),
  },
);

/* ── Bias string → regime ────────────────────────────────────────────────── */
function biasToRegime(bias: string): MarketRegime {
  const b = bias.toUpperCase();
  if (b === "BULLISH")  return "BULL";
  if (b === "BEARISH")  return "BEAR";
  if (b === "SIDEWAYS") return "SIDEWAYS";
  return "UNKNOWN";
}

/* ── VIX normalisation (clamp 10–40 → 0–1) ─────────────────────────────── */
function normaliseVix(vix: number | null): number {
  if (vix == null) return 0.25;
  return Math.min(Math.max((vix - 10) / 30, 0), 1);
}

/* ── Breadth from snapshot ───────────────────────────────────────────────── */
function computeBreadth(indices: Array<{ changePct?: number | null }>, sectors: Array<{ changePct?: number | null }>): number {
  const all = [...indices, ...sectors];
  if (all.length === 0) return 0.5;
  const positive = all.filter((x) => (x.changePct ?? 0) > 0).length;
  return positive / all.length;
}

/* ── Widget ──────────────────────────────────────────────────────────────── */

interface MarketCoreWidgetProps {
  /** Raw nifty bias string from /api/in/nifty-bias */
  niftyBias: string;
  height?: number;
}

export function MarketCoreWidget({ niftyBias, height = 220 }: MarketCoreWidgetProps) {
  const snapshot = useIndiaMarketStore((s) => s.snapshot);

  const indices = snapshot?.indices ?? [];
  const sectors = snapshot?.sectors ?? [];

  // Derive VIX from the "INDIA VIX" index quote
  const vixQuote = indices.find(
    (i) => i.name?.toUpperCase().includes("VIX"),
  );
  const vixValue = vixQuote?.price ?? 15;

  const regime    = biasToRegime(niftyBias);
  const volatility = normaliseVix(vixValue);
  const breadth    = computeBreadth(indices, sectors);

  // Build bottom stat row
  const stats = [
    {
      label: "VIX",
      value: vixValue.toFixed(1),
      positive: vixValue < 20,
    },
    {
      label: "Breadth",
      value: `${Math.round(breadth * 100)}%`,
      positive: breadth > 0.5,
    },
    {
      label: "Vol",
      value: `${Math.round(volatility * 100)}%`,
      positive: volatility < 0.4,
    },
  ];

  return (
    <MarketCoreCard
      regime={regime}
      volatility={volatility}
      breadth={breadth}
      vix={vixValue}
      height={height}
      stats={stats}
    />
  );
}
