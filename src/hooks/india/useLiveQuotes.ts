"use client";

import * as React from "react";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import type { Quote } from "@/types/india";
import { getJson, useFetchPoll } from "./useFetchPoll";

/**
 * Periodically refreshes a set of symbols via /api/in/quote and stores the
 * full Quote objects in the Indian market store. AbortController-aware: a stale
 * fetch is cancelled when the symbol list changes or the component unmounts,
 * so we never starve the browser's per-origin socket pool.
 */
export function useLiveQuotes(symbols: string[], intervalMs = 10_000) {
  const upsertQuotes = useIndiaMarketStore((s) => s.upsertQuotes);

  const subKey = React.useMemo(
    () =>
      Array.from(new Set((symbols ?? []).filter(Boolean)))
        .sort()
        .join(","),
    [symbols],
  );

  useFetchPoll<{ quotes: Quote[] }>(
    (signal) => {
      if (!subKey) return Promise.resolve({ quotes: [] });
      return getJson(`/api/in/quote?symbols=${encodeURIComponent(subKey)}`, signal);
    },
    (data) => {
      if (data.quotes?.length) upsertQuotes(data.quotes);
    },
    { intervalMs },
    [subKey, upsertQuotes],
  );
}
