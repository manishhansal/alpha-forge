"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  ALL_INDIA_STRATEGY_IDS,
  INDIA_SCALP_STRATEGY_IDS,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import {
  INDIA_SCALP_TIMEFRAMES,
  type IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * Client-side selection of active India F&O strategies AND the per-
 * strategy timeframes the user wants to paper-trade on. Modelled on the
 * crypto `src/components/scalper/strategy-context.tsx` — same shape,
 * same persistence pattern (useSyncExternalStore + localStorage) — but
 * with India-scoped data so the two markets never share picker state.
 *
 * Default starts with every strategy active on "5m" (matches crypto).
 */

interface StrategyPair {
  strategyId: IndiaScalpStrategyId;
  timeframe: IndiaScalpTimeframe;
}

interface IndiaStrategyContextValue {
  timeframes: ReadonlyMap<IndiaScalpStrategyId, ReadonlySet<IndiaScalpTimeframe>>;
  selected: ReadonlySet<IndiaScalpStrategyId>;
  pairs: ReadonlyArray<StrategyPair>;
  toggle: (id: IndiaScalpStrategyId) => void;
  toggleTimeframe: (id: IndiaScalpStrategyId, tf: IndiaScalpTimeframe) => void;
  selectAll: () => void;
  selectOnly: (id: IndiaScalpStrategyId) => void;
  isSelected: (id: IndiaScalpStrategyId) => boolean;
  timeframesFor: (id: IndiaScalpStrategyId) => ReadonlySet<IndiaScalpTimeframe>;
}

const IndiaStrategyContext = createContext<IndiaStrategyContextValue | null>(
  null,
);

const STORAGE_KEY = "india-scalper:strategy-timeframes:v1";
const DEFAULT_TIMEFRAME: IndiaScalpTimeframe = "5m";

type StoredFormat = Partial<
  Record<IndiaScalpStrategyId, ReadonlyArray<IndiaScalpTimeframe>>
>;

const DEFAULT_STORED: StoredFormat = Object.fromEntries(
  ALL_INDIA_STRATEGY_IDS.map((id) => [id, [DEFAULT_TIMEFRAME]]),
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
  } catch {
    // fall through to defaults
  }
  return SERVER_SNAPSHOT;
}

function getServerSnapshot(): string {
  return SERVER_SNAPSHOT;
}

function parseSnapshot(
  snapshot: string,
): Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>> {
  try {
    const parsed = JSON.parse(snapshot) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = new Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>>();
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!(INDIA_SCALP_STRATEGY_IDS as readonly string[]).includes(k)) {
          continue;
        }
        if (!Array.isArray(v)) continue;
        const tfs = v.filter(
          (t): t is IndiaScalpTimeframe =>
            typeof t === "string" &&
            (INDIA_SCALP_TIMEFRAMES as readonly string[]).includes(t),
        );
        if (tfs.length === 0) continue;
        out.set(k as IndiaScalpStrategyId, new Set(tfs));
      }
      if (out.size > 0) return out;
    }
  } catch {
    // fall through to defaults
  }
  return defaultMap();
}

function defaultMap(): Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>> {
  const out = new Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>>();
  for (const id of ALL_INDIA_STRATEGY_IDS) {
    out.set(id, new Set([DEFAULT_TIMEFRAME]));
  }
  return out;
}

function cloneMap(
  state: ReadonlyMap<IndiaScalpStrategyId, ReadonlySet<IndiaScalpTimeframe>>,
): Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>> {
  const out = new Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>>();
  for (const [k, v] of state) out.set(k, new Set(v));
  return out;
}

function serialize(
  state: ReadonlyMap<IndiaScalpStrategyId, ReadonlySet<IndiaScalpTimeframe>>,
): string {
  const obj: StoredFormat = {};
  for (const [k, v] of state) {
    if (v.size === 0) continue;
    obj[k] = [...v].sort(
      (a, b) =>
        INDIA_SCALP_TIMEFRAMES.indexOf(a) - INDIA_SCALP_TIMEFRAMES.indexOf(b),
    );
  }
  return JSON.stringify(obj);
}

function persist(
  state: ReadonlyMap<IndiaScalpStrategyId, ReadonlySet<IndiaScalpTimeframe>>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch {
    // Quota / serialisation errors are non-fatal — listeners still fire.
  }
  notify();
}

export function IndiaStrategyProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );
  const state = useMemo(() => parseSnapshot(snapshot), [snapshot]);

  const selected = useMemo(() => {
    const s = new Set<IndiaScalpStrategyId>();
    for (const [id, tfs] of state) if (tfs.size > 0) s.add(id);
    return s;
  }, [state]);

  const pairs = useMemo<StrategyPair[]>(() => {
    const out: StrategyPair[] = [];
    for (const id of ALL_INDIA_STRATEGY_IDS) {
      const tfs = state.get(id);
      if (!tfs) continue;
      for (const tf of INDIA_SCALP_TIMEFRAMES) {
        if (tfs.has(tf)) out.push({ strategyId: id, timeframe: tf });
      }
    }
    return out;
  }, [state]);

  const toggle = useCallback(
    (id: IndiaScalpStrategyId) => {
      const next = cloneMap(state);
      if (next.has(id)) {
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
    (id: IndiaScalpStrategyId, tf: IndiaScalpTimeframe) => {
      const next = cloneMap(state);
      const current = next.get(id);
      if (!current) {
        next.set(id, new Set([tf]));
      } else if (current.has(tf)) {
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
    const next = new Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>>();
    for (const id of ALL_INDIA_STRATEGY_IDS) {
      next.set(id, new Set([DEFAULT_TIMEFRAME]));
    }
    persist(next);
  }, []);

  const selectOnly = useCallback((id: IndiaScalpStrategyId) => {
    const next = new Map<IndiaScalpStrategyId, Set<IndiaScalpTimeframe>>();
    next.set(id, new Set([DEFAULT_TIMEFRAME]));
    persist(next);
  }, []);

  const isSelected = useCallback(
    (id: IndiaScalpStrategyId) => selected.has(id),
    [selected],
  );

  const timeframesFor = useCallback(
    (id: IndiaScalpStrategyId): ReadonlySet<IndiaScalpTimeframe> =>
      state.get(id) ?? new Set<IndiaScalpTimeframe>(),
    [state],
  );

  const value = useMemo<IndiaStrategyContextValue>(
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

  return (
    <IndiaStrategyContext.Provider value={value}>
      {children}
    </IndiaStrategyContext.Provider>
  );
}

export function useIndiaStrategyFilter(): IndiaStrategyContextValue {
  const ctx = useContext(IndiaStrategyContext);
  if (!ctx) {
    throw new Error(
      "useIndiaStrategyFilter must be used inside <IndiaStrategyProvider>",
    );
  }
  return ctx;
}

/** Build the `strategies=` query string. Returns "" when ALL are
 *  selected so the server can cache-key on the all-strategies path. */
export function indiaSelectionToParam(
  selected: ReadonlySet<IndiaScalpStrategyId>,
): string {
  if (selected.size === 0 || selected.size === ALL_INDIA_STRATEGY_IDS.length) {
    return "";
  }
  return [...selected].join(",");
}

/** Build the `sources=` query string of `in:<id>:<tf>` pairs. */
export function indiaPairsToParam(
  pairs: ReadonlyArray<StrategyPair>,
): string {
  if (pairs.length === 0) return "";
  if (
    pairs.length ===
    ALL_INDIA_STRATEGY_IDS.length * INDIA_SCALP_TIMEFRAMES.length
  ) {
    return "";
  }
  return pairs.map((p) => `in:${p.strategyId}:${p.timeframe}`).join(",");
}
