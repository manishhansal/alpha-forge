"use client";

import * as React from "react";
import type { VolSurfaceResponse } from "@/app/api/in/vol-surface/route";

export interface UseVolSurfaceResult {
  data: VolSurfaceResponse | { available: false; reason?: string } | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the SVI-fitted implied volatility surface for the given symbol,
 * polling every 5 minutes (matches the server-side Redis cache TTL).
 *
 * Returns { data, isLoading, error }.
 */
export function useVolSurface(
  symbol: string,
  intervalMs = 5 * 60 * 1000,
): UseVolSurfaceResult {
  const [data, setData] = React.useState<UseVolSurfaceResult["data"]>(null);
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
          `/api/in/vol-surface?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as VolSurfaceResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") return;
        if (!cancelled) {
          setError(
            (err as Error)?.message ?? "Failed to fetch vol surface",
          );
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
