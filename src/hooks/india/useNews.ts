"use client";

import * as React from "react";

import type {
  NewsCategory,
  NewsFeedResponse,
  NewsEventType,
} from "@/types/india/news";
import { getJson, useFetchPoll } from "./useFetchPoll";

export type UseNewsOptions = {
  category?: NewsCategory | "all";
  intervalMs?: number;
  limit?: number;
  /** Filter to articles linked to a specific NSE instrument (e.g. "NIFTY50"). */
  asset_id?: string;
  /** Minimum importance score [0, 1]. */
  min_importance?: number;
  /** Filter by SentinelPulse event type. */
  event_type?: NewsEventType | string;
};

export type UseNewsResult = {
  data: NewsFeedResponse | null;
  loading: boolean;
  error: string | null;
};

/**
 * Loads (and periodically refreshes) the India News feed + aggregate market
 * sentiment from `/api/in/news`.
 *
 * The aggregate `sentiment` is always computed server-side across the full
 * article set so the market read is stable regardless of the active category
 * filter in the UI.
 */
export function useNews(
  categoryOrOpts: NewsCategory | "all" | UseNewsOptions = "all",
  intervalMs = 90_000,
  limit = 40,
): UseNewsResult {
  // Accept either the legacy positional signature or the new options object.
  const opts: UseNewsOptions =
    typeof categoryOrOpts === "object"
      ? categoryOrOpts
      : { category: categoryOrOpts, intervalMs, limit };

  const {
    category = "all",
    intervalMs: pollInterval = intervalMs,
    limit: pageLimit = limit,
    asset_id,
    min_importance,
    event_type,
  } = opts;

  const [data, setData] = React.useState<NewsFeedResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Build query string — only include params that are actually set so the
  // cache key on the server stays stable for common (no-filter) usage.
  const qs = React.useMemo(() => {
    const p = new URLSearchParams();
    p.set("category", category);
    p.set("limit", String(pageLimit));
    if (asset_id) p.set("asset_id", asset_id);
    if (min_importance !== undefined)
      p.set("min_importance", String(min_importance));
    if (event_type) p.set("event_type", event_type);
    return p.toString();
  }, [category, pageLimit, asset_id, min_importance, event_type]);

  useFetchPoll<NewsFeedResponse>(
    async (signal) => {
      setLoading(true);
      try {
        const json = await getJson<NewsFeedResponse>(
          `/api/in/news?${qs}`,
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
      intervalMs: pollInterval,
      onError: (e: unknown) => setError((e as Error)?.message ?? "Failed"),
    },
    [qs],
  );

  return { data, loading, error };
}
