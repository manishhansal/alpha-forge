/**
 * signalToRadarRow — server-safe utility.
 *
 * Pure function with no React hooks or browser APIs. Lives in src/lib/
 * (no "use client") so it can be called from server components without
 * triggering the Next.js boundary error.
 */

import type { AiRadarRow } from "@/components/trading/AiRadar";
import type { AiAction } from "@/components/trading/SignalBadge";
import type { RegimeLabel } from "@/components/trading/RegimeBadge";
import type { AiSignal } from "@/types/ai-signals";

export function signalToRadarRow(signal: AiSignal, rank: number): AiRadarRow {
  const regimeFromSignal = (): RegimeLabel => {
    if (signal.direction === "BULLISH" && signal.confidenceScore >= 60) return "BULL";
    if (signal.direction === "BEARISH" && signal.confidenceScore >= 60) return "BEAR";
    if (signal.direction === "NEUTRAL") return "SIDEWAYS";
    return "UNKNOWN";
  };

  const action = signal.action as AiAction;

  const momentumFromConfluences = (): number[] => {
    const momentumFactor = signal.confluences.find((c) => c.id === "momentum");
    if (momentumFactor) {
      const s = momentumFactor.score;
      const base = signal.underlyingPrice;
      const step = base * Math.abs(s) * 0.003;
      return Array.from({ length: 5 }, (_, i) =>
        s >= 0 ? base + step * i : base - step * i,
      );
    }
    return Array.from({ length: 5 }, () => signal.underlyingPrice);
  };

  const relVolFromConfluences = (): number => {
    const volFactor = signal.confluences.find((c) => c.id === "volume");
    if (volFactor && volFactor.available) {
      return Math.max(0.1, 1 + volFactor.score);
    }
    return 1.0;
  };

  const oiDeltaFromConfluences = (): number => {
    const oiFactor = signal.confluences.find(
      (c) => c.id === "oiBuildup" || c.id === "oiSkew" || c.id === "pcr",
    );
    if (oiFactor && oiFactor.available) {
      return oiFactor.score * 0.15;
    }
    return 0;
  };

  const confluences = signal.confluences
    .filter((c) => c.available)
    .map((c) => ({
      factor: c.label,
      value: c.description,
      positive: c.score >= 0,
    }));

  return {
    rank,
    symbol: signal.symbol,
    sector: signal.market === "india" ? "F&O" : "Crypto",
    aiScore: signal.confidenceScore,
    momentum5d: momentumFromConfluences(),
    relativeVolume: relVolFromConfluences(),
    oiDelta: oiDeltaFromConfluences(),
    regime: regimeFromSignal(),
    signal: action,
    entry: signal.entry,
    stop: signal.stopLoss,
    tp1: signal.takeProfits[0]?.price,
    winProbability: signal.winProbability,
    confluences,
  };
}
