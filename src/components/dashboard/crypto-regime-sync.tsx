"use client";

/**
 * CryptoRegimeSync — invisible client component that bridges the crypto market
 * store to UIStore regime. It runs inside the Crypto Overview server page and
 * fires setRegime whenever the crypto tickers change.
 *
 * Regime derivation heuristic (ticker-based, no ML round-trip):
 *   - BTC 24h change >= +3%    → BULL
 *   - BTC 24h change <= -3%    → BEAR
 *   - BTC 24h change outside ±3% but within ±6% abs (undefined yet) → SIDEWAYS
 *   - If no ticker data yet    → UNKNOWN
 *
 * This is deliberately simple — the ML service provides deeper regime signals,
 * but for the UI store we derive a fast heuristic from live tickers.
 */

import { useEffect } from "react";
import { useMarketStore } from "@/store/marketStore";
import { useUIStore, type MarketRegime } from "@/store/uiStore";

function deriveCryptoRegime(btcChangePct: number | null): MarketRegime {
  if (btcChangePct == null) return "UNKNOWN";
  if (btcChangePct >= 3) return "BULL";
  if (btcChangePct <= -3) return "BEAR";
  return "SIDEWAYS";
}

export function CryptoRegimeSync() {
  const btcTicker = useMarketStore((s) => s.tickers["BTC"]);
  const setRegime = useUIStore((s) => s.setRegime);

  useEffect(() => {
    const changePct = btcTicker?.changePct24h ?? null;
    setRegime(deriveCryptoRegime(changePct));
  }, [btcTicker, setRegime]);

  // Renders nothing — pure side-effect component.
  return null;
}
