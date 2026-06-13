"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ALL_STRATEGY_IDS } from "@/features/scalping/strategies/catalog";
import {
  SCALP_STRATEGY_IDS,
  type ScalpStrategyId,
  type ScalpTimeframe,
} from "@/features/scalping/types";

/**
 * Shared client-side selection of active scalping strategies AND the
 * per-strategy timeframes the user wants to paper-trade on. Persisted to
 * localStorage so a page reload retains the picker state.
 *
 * Model:
 *   `timeframes: Map<ScalpStrategyId, Set<ScalpTimeframe>>`
 * A strategy is "active" iff its set is non-empty. By default every strategy
 * starts with `{"5m"}` selected — the user can then add 1m / 15m lanes per
 * strategy. The worker still generates paper trades for every (strategy ×
 * timeframe) combination in the background; this state only drives display
 * filtering (signals + journal).
 *
 * Backed by `useSyncExternalStore` against a localStorage-shaped store so the
 * SSR snapshot is stable ("everything at 5m") and the client snapshot is
 * tearing-free across components that mount at different times.
 */

interface StrategyPair {
  strategyId: ScalpStrategyId;
  timeframe: ScalpTimeframe;
}

interface StrategyContextValue {
  /** Live state — map of strategy id → set of selected timeframes. */
  timeframes: ReadonlyMap<ScalpStrategyId, ReadonlySet<ScalpTimeframe>>;
  /** Set of strategies with at least one timeframe selected. */
  selected: ReadonlySet<ScalpStrategyId>;
  /** Flattened (strategy × timeframe) pairs — the paper-trading lanes. */
  pairs: ReadonlyArray<StrategyPair>;
  /** Turn a strategy on (with default 5m) or off (clears all its tfs). */
  toggle: (id: ScalpStrategyId) => void;
  /** Toggle a single (strategy, timeframe) lane. */
  toggleTimeframe: (id: ScalpStrategyId, tf: ScalpTimeframe) => void;
  selectAll: () => void;
  selectOnly: (id: ScalpStrategyId) => void;
  isSelected: (id: ScalpStrategyId) => boolean;
  timeframesFor: (id: ScalpStrategyId) => ReadonlySet<ScalpTimeframe>;
}

const StrategyContext = createContext<StrategyContextValue | null>(null);

const STORAGE_KEY = "scalper:strategy-timeframes:v1";
/** Legacy CSV-of-strategy-ids key from before per-strategy timeframes. */
const LEGACY_STORAGE_KEY = "scalper:selected-strategies:v1";

const ALL_TIMEFRAMES: ReadonlyArray<ScalpTimeframe> = ["1m", "5m", "15m"];
const DEFAULT_TIMEFRAME: ScalpTimeframe = "5m";

type StoredFormat = Partial<Record<ScalpStrategyId, ReadonlyArray<ScalpTimeframe>>>;

const DEFAULT_STORED: StoredFormat = Object.fromEntries(
  ALL_STRATEGY_IDS.map((id) => [id, [DEFAULT_TIMEFRAME]]),
) as StoredFormat;

const SERVER_SNAPSHOT = JSON.stringify(DEFAULT_STORED);

const listeners = new Set<() => void>();
function notify(): void {
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function getClientSnapshot(): string {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && raw.length > 0) return raw;
    // First load after upgrading from the CSV format — migrate so the user
    // doesn't lose their previously-selected strategies.
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && legacy.length > 0) {
      const ids = parseLegacyCsv(legacy);
      if (ids.length > 0) {
        const migrated: StoredFormat = Object.fromEntries(
          ids.map((id) => [id, [DEFAULT_TIMEFRAME]]),
        ) as StoredFormat;
        return JSON.stringify(migrated);
      }
    }
  } catch {
    // fall through
  }
  return SERVER_SNAPSHOT;
}

function getServerSnapshot(): string {
  return SERVER_SNAPSHOT;
}

function parseLegacyCsv(raw: string): ScalpStrategyId[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(
      (id): id is ScalpStrategyId =>
        typeof id === "string" && (SCALP_STRATEGY_IDS as readonly string[]).includes(id),
    );
}

function parseSnapshot(
  snapshot: string,
): Map<ScalpStrategyId, Set<ScalpTimeframe>> {
  try {
    const parsed = JSON.parse(snapshot) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = new Map<ScalpStrategyId, Set<ScalpTimeframe>>();
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!(SCALP_STRATEGY_IDS as readonly string[]).includes(k)) continue;
        if (!Array.isArray(v)) continue;
        const tfs = v.filter(
          (t): t is ScalpTimeframe =>
            typeof t === "string" && (ALL_TIMEFRAMES as readonly string[]).includes(t),
        );
        if (tfs.length === 0) continue;
        out.set(k as ScalpStrategyId, new Set(tfs));
      }
      if (out.size > 0) return out;
    }
  } catch {
    // fall through to defaults
  }
  return defaultMap();
}

function defaultMap(): Map<ScalpStrategyId, Set<ScalpTimeframe>> {
  const out = new Map<ScalpStrategyId, Set<ScalpTimeframe>>();
  for (const id of ALL_STRATEGY_IDS) {
    out.set(id, new Set([DEFAULT_TIMEFRAME]));
  }
  return out;
}

function cloneMap(
  state: ReadonlyMap<ScalpStrategyId, ReadonlySet<ScalpTimeframe>>,
): Map<ScalpStrategyId, Set<ScalpTimeframe>> {
  const out = new Map<ScalpStrategyId, Set<ScalpTimeframe>>();
  for (const [k, v] of state) out.set(k, new Set(v));
  return out;
}

function serialize(
  state: ReadonlyMap<ScalpStrategyId, ReadonlySet<ScalpTimeframe>>,
): string {
  const obj: StoredFormat = {};
  for (const [k, v] of state) {
    if (v.size === 0) continue;
    obj[k] = [...v].sort(
      (a, b) => ALL_TIMEFRAMES.indexOf(a) - ALL_TIMEFRAMES.indexOf(b),
    );
  }
  return JSON.stringify(obj);
}

function persist(
  state: ReadonlyMap<ScalpStrategyId, ReadonlySet<ScalpTimeframe>>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch {
    // Quota or serialisation errors are non-fatal — listeners still fire and
    // in-memory state stays correct.
  }
  notify();
}

export function StrategyProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  const state = useMemo(() => parseSnapshot(snapshot), [snapshot]);

  const selected = useMemo(() => {
    const s = new Set<ScalpStrategyId>();
    for (const [id, tfs] of state) if (tfs.size > 0) s.add(id);
    return s;
  }, [state]);

  const pairs = useMemo<StrategyPair[]>(() => {
    const out: StrategyPair[] = [];
    // Iterate in catalog order so the URL param and any UI consumers see a
    // stable, deterministic ordering.
    for (const id of ALL_STRATEGY_IDS) {
      const tfs = state.get(id);
      if (!tfs) continue;
      for (const tf of ALL_TIMEFRAMES) {
        if (tfs.has(tf)) out.push({ strategyId: id, timeframe: tf });
      }
    }
    return out;
  }, [state]);

  const toggle = useCallback(
    (id: ScalpStrategyId) => {
      const next = cloneMap(state);
      if (next.has(id)) {
        // Keep the invariant that at least one strategy stays active.
        if (selected.size === 1) return;
        next.delete(id);
      } else {
        next.set(id, new Set([DEFAULT_TIMEFRAME]));
      }
      persist(next);
    },
    [state, selected],
  );

  const toggleTimeframe = useCallback(
    (id: ScalpStrategyId, tf: ScalpTimeframe) => {
      const next = cloneMap(state);
      const current = next.get(id);
      if (!current) {
        next.set(id, new Set([tf]));
      } else if (current.has(tf)) {
        // Don't let the user clear the last (strategy × tf) lane in the
        // whole picker — otherwise nothing renders and they can't recover.
        if (current.size === 1 && selected.size === 1) return;
        current.delete(tf);
        if (current.size === 0) next.delete(id);
      } else {
        current.add(tf);
      }
      persist(next);
    },
    [state, selected],
  );

  const selectAll = useCallback(() => {
    const next = new Map<ScalpStrategyId, Set<ScalpTimeframe>>();
    for (const id of ALL_STRATEGY_IDS) {
      next.set(id, new Set([DEFAULT_TIMEFRAME]));
    }
    persist(next);
  }, []);

  const selectOnly = useCallback((id: ScalpStrategyId) => {
    const next = new Map<ScalpStrategyId, Set<ScalpTimeframe>>();
    next.set(id, new Set([DEFAULT_TIMEFRAME]));
    persist(next);
  }, []);

  const isSelected = useCallback(
    (id: ScalpStrategyId) => selected.has(id),
    [selected],
  );

  const timeframesFor = useCallback(
    (id: ScalpStrategyId): ReadonlySet<ScalpTimeframe> =>
      state.get(id) ?? new Set<ScalpTimeframe>(),
    [state],
  );

  const value = useMemo<StrategyContextValue>(
    () => ({
      timeframes: state,
      selected,
      pairs,
      toggle,
      toggleTimeframe,
      selectAll,
      selectOnly,
      isSelected,
      timeframesFor,
    }),
    [
      state,
      selected,
      pairs,
      toggle,
      toggleTimeframe,
      selectAll,
      selectOnly,
      isSelected,
      timeframesFor,
    ],
  );

  return <StrategyContext.Provider value={value}>{children}</StrategyContext.Provider>;
}

export function useStrategyFilter(): StrategyContextValue {
  const ctx = useContext(StrategyContext);
  if (!ctx) {
    throw new Error("useStrategyFilter must be used inside <StrategyProvider>");
  }
  return ctx;
}

/**
 * Build the comma-separated `strategies=` query string for API calls. Empty
 * string is returned when all strategies are selected so the server still
 * uses its default (and cache key) of "all strategies".
 */
export function selectionToParam(
  selected: ReadonlySet<ScalpStrategyId>,
): string {
  if (selected.size === 0 || selected.size === ALL_STRATEGY_IDS.length) return "";
  return [...selected].join(",");
}

/**
 * Build a `sources=` query string of `strategyId:timeframe` pairs — the
 * exact format used by `PaperTrade.source` so the journal API can do an
 * `IN (...)` filter without expansion. Returns "" when every possible lane
 * is selected so the server can short-circuit.
 */
export function pairsToParam(pairs: ReadonlyArray<StrategyPair>): string {
  if (pairs.length === 0) return "";
  if (pairs.length === ALL_STRATEGY_IDS.length * ALL_TIMEFRAMES.length) return "";
  return pairs.map((p) => `${p.strategyId}:${p.timeframe}`).join(",");
}
