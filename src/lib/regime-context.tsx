"use client";

import * as React from "react";
import { useUIStore, type MarketRegime } from "@/store/uiStore";

export type { MarketRegime };

interface RegimeContextValue {
  regime: MarketRegime;
  isHighVol: boolean;
  vix: number | null;
}

// Default context value — consumers that don't have a provider will get UNKNOWN.
export const RegimeContext = React.createContext<RegimeContextValue>({
  regime: "UNKNOWN",
  isHighVol: false,
  vix: null,
});

/** Hook for consumers — read current regime and derived state. */
export function useRegime(): RegimeContextValue {
  return React.useContext(RegimeContext);
}

interface RegimeProviderProps {
  children: React.ReactNode;
  /** Raw India VIX value — read from snapshot in the India layout. */
  vix?: number | null;
}

export function RegimeProvider({ children, vix = null }: RegimeProviderProps) {
  const regime = useUIStore((s) => s.activeRegime);

  // VIX > 25 triggers the high-vol warning chip in the Topbar (3-point
  // hysteresis is handled upstream — the provider just reflects the raw value).
  const isHighVol = vix != null && vix > 25;

  // Aurora CSS variable injection — CSS transitions (1200ms ease) handle the
  // smooth regime color shift without a JS animation loop.
  const auroraColor =
    regime === "BULL"
      ? "oklch(0.50 0.18 155 / 18%)"
      : regime === "BEAR"
        ? "oklch(0.42 0.18 22  / 18%)"
        : regime === "SIDEWAYS"
          ? "oklch(0.50 0.18 200 / 18%)"
          : "oklch(0.50 0.18 200 / 18%)"; // UNKNOWN / HIGH_VOL → neutral

  return (
    <RegimeContext.Provider value={{ regime, isHighVol, vix }}>
      {/*
       * Inject --aurora-regime-a as an inline CSS variable so the aurora
       * background component can pick it up via var(--aurora-regime-a).
       * display: contents ensures this div has no layout impact.
       */}
      <div
        style={
          {
            "--aurora-regime-a": auroraColor,
            transition: "--aurora-regime-a 1200ms ease",
            display: "contents",
          } as React.CSSProperties
        }
      >
        {children}
      </div>
    </RegimeContext.Provider>
  );
}
