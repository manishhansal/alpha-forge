"use client";

import * as React from "react";
import { useRegime } from "@/lib/regime-context";
import type { MarketRegime } from "@/store/uiStore";

// Context sentences shown per regime
const REGIME_CONTEXT: Record<MarketRegime, string> = {
  BULL:     "Breadth is positive — momentum favours long setups.",
  BEAR:     "Broad selling pressure — focus on short setups and hedges.",
  SIDEWAYS: "Range-bound conditions — favour mean-reversion strategies.",
  HIGH_VOL: "Elevated volatility — size down and widen stops.",
  UNKNOWN:  "Regime data loading — monitoring market conditions.",
};

export function RegimeBanner() {
  const { regime } = useRegime();

  const label = regime === "HIGH_VOL" ? "HIGH VOL" : regime;
  const sentence = REGIME_CONTEXT[regime];

  return (
    <div
      role="status"
      aria-label={`Market regime: ${label}`}
      className="flex h-[28px] w-full items-center gap-3 px-4 text-[11px] font-medium"
      style={{
        background: `var(--color-regime-${regime.toLowerCase().replace("_", "")}, var(--color-surface))`,
        color: "var(--color-fg)",
        borderBottom: "1px solid var(--color-panel-border)",
        transition: "background 1200ms ease",
      }}
    >
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest"
        style={{
          background: "color-mix(in oklch, var(--color-fg) 8%, transparent)",
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--color-fg-muted)" }}>{sentence}</span>
    </div>
  );
}
