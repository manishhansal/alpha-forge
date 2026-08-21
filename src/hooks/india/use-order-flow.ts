"use client";

import * as React from "react";
import type { VpinResponse } from "@/app/api/in/order-flow/route";

export interface UseOrderFlowResult {
  data: VpinResponse | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches VPIN order-flow data for the given symbol, polling every 2 minutes
 * (matches the server-side Redis cache TTL).
 *
 * Returns { data, isLoading, error }.
 */
export function useOrderFlow(
  symbol: string,
  intervalMs = 2 * 60 * 1000,
): UseOrderFlowResult {
  const [data, setData] = React.useState<VpinResponse | null>(null);
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
          `/api/in/order-flow?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as VpinResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") return;
        if (!cancelled) {
          setError((err as Error)?.message ?? "Failed to fetch order flow");
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
