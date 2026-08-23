"use client";

/**
 * RegimeSync — invisible client component that bridges IndiaMarketStore →
 * UIStore regime. It runs inside the server DashboardLayout (via RegimeProvider)
 * and fires setRegime whenever the India snapshot indices change.
 *
 * Regime derivation heuristic (snapshot-based, no ML round-trip):
 *   - India VIX > 25          → HIGH_VOL
 *   - NIFTY 50 changePct >= 0.3  → BULL
 *   - NIFTY 50 changePct <= -0.3 → BEAR
 *   - otherwise                → SIDEWAYS
 *   - no snapshot yet          → UNKNOWN
 */

import { useEffect } from "react";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useUIStore, type MarketRegime } from "@/store/uiStore";

function deriveRegime(
  vix: number | null,
  niftyChangePct: number | null,
): MarketRegime {
  if (vix != null && vix > 25) return "HIGH_VOL";
  if (niftyChangePct == null) return "UNKNOWN";
  if (niftyChangePct >= 0.3) return "BULL";
  if (niftyChangePct <= -0.3) return "BEAR";
  return "SIDEWAYS";
}

export function RegimeSync() {
  const snapshot  = useIndiaMarketStore((s) => s.snapshot);
  const setRegime = useUIStore((s) => s.setRegime);

  useEffect(() => {
    const indices = snapshot?.indices ?? [];

    const vixEntry    = indices.find((idx) =>
      idx.name.toUpperCase().includes("VIX"),
    );
    const niftyEntry  = indices.find((idx) =>
      idx.name.toUpperCase().includes("NIFTY 50"),
    );

    const vix           = vixEntry?.price ?? null;
    const niftyChangePct = niftyEntry?.changePct ?? null;

    setRegime(deriveRegime(vix, niftyChangePct));
  }, [snapshot, setRegime]);

  // Renders nothing — pure side-effect component.
  return null;
}
