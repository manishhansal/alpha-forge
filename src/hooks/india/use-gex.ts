"use client";

import * as React from "react";
import type { GexResult } from "@/app/api/in/gex/route";

export interface UseGexResult {
  data: GexResult | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches GEX (Dealer Gamma Exposure) data for the given symbol, polling
 * every 5 minutes (matches the server-side Redis cache TTL).
 *
 * Returns { data, isLoading, error }.
 *
 * Validates: Requirements 4.5, 4.6, 4.7
 */
export function useGex(
  symbol: string,
  intervalMs = 5 * 60 * 1000,
): UseGexResult {
  const [data, setData] = React.useState<GexResult | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const res = await fetch(
          `/api/in/gex?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as GexResult;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") return;
        if (!cancelled) {
          setError((err as Error)?.message ?? "Failed to fetch GEX data");
        }
      } finally {
        inFlight = false;
        if (!cancelled) setIsLoading(false);
      }
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    void tick();

    const jitter = Math.floor(Math.random() * intervalMs * 0.1);
    const id = setInterval(tick, intervalMs + jitter);

    return () => {
      cancelled = true;
      clearInterval(id);
      controller?.abort();
    };
  }, [symbol, intervalMs]);

  return { data, isLoading, error };
}
