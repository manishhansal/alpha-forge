"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ScalperBacktestSummary } from "@/features/scalping/backtest-summary-types";
import type { ScalpStrategyId } from "@/features/scalping/types";
import type { StrategyScoreBreakdown } from "@/features/scalping/strategy-score";
import {
  BACKTEST_INTERVAL_DEFAULT,
  BACKTEST_INTERVAL_OPTIONS,
  type BacktestInterval,
} from "@/features/scalping/backtest-intervals";

/**
 * Lazy client-side loader for the multi-strategy scalp backtest suite.
 *
 * The first request after a cold start can take 20-30s while the server
 * computes every (strategy × symbol) backtest, so we:
 *
 *   1. Fire one request from a top-level provider (mounted by both the
 *      Scalper page and the dedicated Strategy Backtest page).
 *   2. Multiplex the in-flight promise to every consumer via React context.
 *   3. Cache the resolved payload **per interval** on `window` so soft
 *      navigations and timeframe toggles don't re-fetch payloads the
 *      server is already caching itself.
 *
 * Consumers get `{ data, loading, error, refresh, interval, setInterval,
 * scoreFor(id) }` and can render placeholders (e.g. the
 * `StrategyScoreBadge` falls back to a "Backtest pending" pill) while
 * `loading` is true. The Scalper page mounts the provider with no props
 * (defaults to the canonical `4h` strategy-picker scores). The Strategy
 * Backtest page mounts it with `initialInterval="5m"` and exposes a
 * timeframe toggle that calls `setInterval`.
 */

interface StrategyBacktestContextValue {
  data: ScalperBacktestSummary | null;
  loading: boolean;
  error: string | null;
  /** Current bar interval the displayed `data` was computed on. */
  interval: BacktestInterval;
  /** All supported interval choices, in display order. */
  intervalOptions: ReadonlyArray<BacktestInterval>;
  /** Swap to a different bar interval (triggers a fetch if uncached). */
  setInterval: (interval: BacktestInterval) => void;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  scoreFor: (id: ScalpStrategyId) => StrategyScoreBreakdown | null;
}

const StrategyBacktestContext = createContext<StrategyBacktestContextValue | null>(null);

const ENDPOINT = "/api/scalper/backtest";
const WINDOW_CACHE_KEY = "__scalpBacktestCache";

interface WindowCache {
  /** Cached summary keyed by interval — survives soft navigations within a
   *  single page-load so toggling timeframes feels instant. */
  byInterval: Partial<Record<BacktestInterval, ScalperBacktestSummary>>;
}

function getWindowCache(): WindowCache | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const existing = w[WINDOW_CACHE_KEY] as Partial<WindowCache> | undefined;
  if (!existing || !existing.byInterval) {
    const fresh: WindowCache = { byInterval: {} };
    w[WINDOW_CACHE_KEY] = fresh;
    return fresh;
  }
  return existing as WindowCache;
}

export function StrategyBacktestProvider({
  children,
  initialInterval,
}: {
  children: ReactNode;
  /** Starting bar interval — defaults to the canonical `4h` so the Scalper
   *  page's strategy chips keep their long-form score behaviour. */
  initialInterval?: BacktestInterval;
}) {
  const startInterval = initialInterval ?? BACKTEST_INTERVAL_DEFAULT;
  const cache = getWindowCache();
  const [interval, setIntervalState] = useState<BacktestInterval>(startInterval);
  const [data, setData] = useState<ScalperBacktestSummary | null>(
    cache?.byInterval[startInterval] ?? null,
  );
  // Loading is true on first mount when we don't already have a cached
  // payload; the fetch effect below flips it to false on resolve / error.
  const [loading, setLoading] = useState<boolean>(!cache?.byInterval[startInterval]);
  const [error, setError] = useState<string | null>(null);
  /** Keyed by interval so timeframe toggles never collide. */
  const inflightRef = useRef<Map<BacktestInterval, Promise<void>>>(new Map());

  const fetchSuite = useCallback(
    async (target: BacktestInterval, opts?: { force?: boolean }) => {
      setError(null);
      setLoading(true);
      const params = new URLSearchParams({ detail: "summary", interval: target });
      if (opts?.force) params.set("force", "1");
      const url = `${ENDPOINT}?${params.toString()}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Request failed: ${res.status} ${text || res.statusText}`);
        }
        const json = (await res.json()) as ScalperBacktestSummary;
        // Only commit the payload to UI state if the user is still
        // looking at this interval — otherwise just warm the window cache.
        const win = getWindowCache();
        if (win) win.byInterval[target] = json;
        setIntervalState((current) => {
          if (current === target) setData(json);
          return current;
        });
      } catch (err) {
        setIntervalState((current) => {
          if (current === target) setError((err as Error).message);
          return current;
        });
      } finally {
        setIntervalState((current) => {
          if (current === target) setLoading(false);
          return current;
        });
      }
    },
    [],
  );

  const refreshInterval = useCallback(
    (target: BacktestInterval, opts?: { force?: boolean }): Promise<void> => {
      const inflight = inflightRef.current.get(target);
      if (inflight && !opts?.force) return inflight;
      const p = fetchSuite(target, opts).finally(() => {
        if (inflightRef.current.get(target) === p) {
          inflightRef.current.delete(target);
        }
      });
      inflightRef.current.set(target, p);
      return p;
    },
    [fetchSuite],
  );

  const refresh = useCallback(
    (opts?: { force?: boolean }) => refreshInterval(interval, opts),
    [interval, refreshInterval],
  );

  const setInterval = useCallback(
    (next: BacktestInterval) => {
      if (next === interval) return;
      setIntervalState(next);
      const win = getWindowCache();
      const cached = win?.byInterval[next] ?? null;
      setData(cached);
      setError(null);
      if (cached) {
        setLoading(false);
      } else {
        setLoading(true);
        void refreshInterval(next);
      }
    },
    [interval, refreshInterval],
  );

  useEffect(() => {
    // Kick off the initial fetch once the provider mounts. If a sibling
    // provider already populated the window cache for this interval we skip
    // the network round-trip entirely — `loading` was initialised to false
    // for that branch so there's no setState to undo here.
    if (data) return;
    void refreshInterval(interval);
    // Only run on mount — `refreshInterval` is a stable callback and `data`
    // flipping to non-null during the fetch shouldn't retrigger a second
    // request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scoreFor = useCallback(
    (id: ScalpStrategyId): StrategyScoreBreakdown | null => {
      if (!data) return null;
      const row = data.reports.find((r) => r.strategyId === id);
      return row?.score ?? null;
    },
    [data],
  );

  const value = useMemo<StrategyBacktestContextValue>(
    () => ({
      data,
      loading,
      error,
      interval,
      intervalOptions: BACKTEST_INTERVAL_OPTIONS,
      setInterval,
      refresh,
      scoreFor,
    }),
    [data, loading, error, interval, setInterval, refresh, scoreFor],
  );

  return (
    <StrategyBacktestContext.Provider value={value}>
      {children}
    </StrategyBacktestContext.Provider>
  );
}

export function useStrategyBacktest(): StrategyBacktestContextValue {
  const ctx = useContext(StrategyBacktestContext);
  if (!ctx) {
    // Allow consumers to be rendered outside the provider — they'll just
    // see "no data". This keeps the picker safe to drop in elsewhere.
    return {
      data: null,
      loading: false,
      error: null,
      interval: BACKTEST_INTERVAL_DEFAULT,
      intervalOptions: BACKTEST_INTERVAL_OPTIONS,
      setInterval: () => {},
      refresh: async () => {},
      scoreFor: () => null,
    };
  }
  return ctx;
}
