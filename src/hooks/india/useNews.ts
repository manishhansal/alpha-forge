"use client";

import * as React from "react";

import type { NewsCategory, NewsFeedResponse } from "@/types/india/news";
import { getJson, useFetchPoll } from "./useFetchPoll";

export type UseNewsResult = {
  data: NewsFeedResponse | null;
  loading: boolean;
  error: string | null;
};

/**
 * Loads (and periodically refreshes) the India News feed + aggregate market
 * sentiment from `/api/in/news`. The aggregate `sentiment` is always computed
 * across every category server-side, so it's stable regardless of the
 * category the UI is currently filtering to.
 */
export function useNews(
  category: NewsCategory | "all" = "all",
  intervalMs = 60_000,
  limit = 40,
): UseNewsResult {
  const [data, setData] = React.useState<NewsFeedResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  useFetchPoll<NewsFeedResponse>(
    async (signal) => {
      setLoading(true);
      try {
        const json = await getJson<NewsFeedResponse>(
          `/api/in/news?category=${encodeURIComponent(category)}&limit=${limit}`,
          signal,
        );
        setError(null);
        return json;
      } finally {
        setLoading(false);
      }
    },
    (json) => setData(json),
    {
      intervalMs,
      onError: (e: unknown) => setError((e as Error)?.message ?? "Failed"),
    },
    [category, limit],
  );

  return { data, loading, error };
}
