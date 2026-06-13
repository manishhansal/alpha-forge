"use client";

import { useIndiaOptionChainStore } from "@/store/india/optionChainStore";
import type { OptionChain } from "@/types/india";
import { getJson, useFetchPoll } from "./useFetchPoll";

/**
 * Loads the option chain for the active symbol/expiry from /api/in/option-chain
 * and refreshes every `intervalMs` (default 20s — mirrors the server cache).
 */
export function useOptionChain(intervalMs = 20_000) {
  const symbol = useIndiaOptionChainStore((s) => s.symbol);
  const expiry = useIndiaOptionChainStore((s) => s.expiry);
  const refreshTick = useIndiaOptionChainStore((s) => s.refreshTick);
  const setData = useIndiaOptionChainStore((s) => s.setData);
  const setLoading = useIndiaOptionChainStore((s) => s.setLoading);
  const setError = useIndiaOptionChainStore((s) => s.setError);

  useFetchPoll<OptionChain>(
    async (signal) => {
      setLoading(true);
      try {
        const url = `/api/in/option-chain?symbol=${encodeURIComponent(symbol)}${
          expiry ? `&expiry=${encodeURIComponent(expiry)}` : ""
        }`;
        const data = await getJson<OptionChain>(url, signal);
        setError(null);
        return data;
      } finally {
        setLoading(false);
      }
    },
    (data) => setData(data),
    {
      intervalMs,
      onError: (e: unknown) =>
        setError((e as Error)?.message ?? "Failed"),
    },
    [symbol, expiry, refreshTick],
  );
}
