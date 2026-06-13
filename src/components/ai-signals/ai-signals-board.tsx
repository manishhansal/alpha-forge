"use client";

import * as React from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  Filter,
  Pause,
  RefreshCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { AiMarketContextBanner } from "./ai-market-context-banner";
import { AiSignalCard } from "./ai-signal-card";
import type { AiSignal, AiSignalsResponse } from "@/types/ai-signals";

interface Props {
  initialData: AiSignalsResponse;
  /** Endpoint to poll. Defaults to `/api/ai-signals`. */
  endpoint?: string;
  /** Poll interval in ms. Defaults to 30s. */
  intervalMs?: number;
  /** Currency to render prices in. */
  currency?: "usd" | "inr";
}

type DirectionFilter = "all" | "bullish" | "bearish" | "wait";

const DIRECTION_OPTIONS: Array<{
  id: DirectionFilter;
  label: string;
  icon: typeof ArrowUpRight;
}> = [
  { id: "all", label: "All", icon: Filter },
  { id: "bullish", label: "Bullish", icon: ArrowUpRight },
  { id: "bearish", label: "Bearish", icon: ArrowDownRight },
  { id: "wait", label: "Wait", icon: Pause },
];

const HORIZON_OPTIONS: Array<{
  id: AiSignal["horizon"] | "all";
  label: string;
}> = [
  { id: "all", label: "Any horizon" },
  { id: "scalp", label: "Scalp" },
  { id: "intraday", label: "Intraday" },
  { id: "swing", label: "Swing" },
  { id: "positional", label: "Positional" },
];

const STORAGE_KEY_DIR = "ai-signals:dir";
const STORAGE_KEY_HORIZON = "ai-signals:horizon";

const VALID_DIRECTIONS: DirectionFilter[] = ["all", "bullish", "bearish", "wait"];
const VALID_HORIZONS: Array<AiSignal["horizon"] | "all"> = [
  "all",
  "scalp",
  "intraday",
  "swing",
  "positional",
];

// `useSyncExternalStore` is the React-19 blessed way to read a value off an
// external system (localStorage in this case). It handles the SSR snapshot
// correctly (returns the same value on every server render) and the client
// snapshot on first paint, so we don't need a useEffect → setState dance.
const localStorageSubscribers = new Set<() => void>();
function subscribeToLocalStorage(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback();
  window.addEventListener("storage", handler);
  localStorageSubscribers.add(callback);
  return () => {
    window.removeEventListener("storage", handler);
    localStorageSubscribers.delete(callback);
  };
}
function notifyLocalStorage() {
  for (const cb of localStorageSubscribers) cb();
}
function readPersisted<T extends string>(
  key: string,
  valid: readonly T[],
  fallback: T,
): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && (valid as readonly string[]).includes(raw)) return raw as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

function useDirectionFilter(): [
  DirectionFilter,
  (next: DirectionFilter) => void,
] {
  const value = React.useSyncExternalStore(
    subscribeToLocalStorage,
    () => readPersisted(STORAGE_KEY_DIR, VALID_DIRECTIONS, "all"),
    () => "all" as DirectionFilter,
  );
  const setValue = React.useCallback((next: DirectionFilter) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY_DIR, next);
    } catch {
      /* ignore */
    }
    notifyLocalStorage();
  }, []);
  return [value, setValue];
}

function useHorizonFilter(): [
  AiSignal["horizon"] | "all",
  (next: AiSignal["horizon"] | "all") => void,
] {
  const value = React.useSyncExternalStore(
    subscribeToLocalStorage,
    () => readPersisted(STORAGE_KEY_HORIZON, VALID_HORIZONS, "all"),
    () => "all" as AiSignal["horizon"] | "all",
  );
  const setValue = React.useCallback((next: AiSignal["horizon"] | "all") => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY_HORIZON, next);
    } catch {
      /* ignore */
    }
    notifyLocalStorage();
  }, []);
  return [value, setValue];
}

/**
 * Live AI Signals board — paints the SSR-prefetched payload immediately,
 * then polls the API every `intervalMs` for refreshed signals. Persists
 * the filter selection to localStorage so it's sticky across reloads.
 */
export function AiSignalsBoard({
  initialData,
  endpoint = "/api/ai-signals",
  intervalMs = 30_000,
  currency = "usd",
}: Props) {
  const [data, setData] = React.useState<AiSignalsResponse>(initialData);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useDirectionFilter();
  const [horizonFilter, setHorizonFilter] = useHorizonFilter();

  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      try {
        const res = await fetch(endpoint, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AiSignalsResponse;
        setData(json);
        setError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      } finally {
        setRefreshing(false);
      }
    },
    [endpoint],
  );

  React.useEffect(() => {
    const ac = new AbortController();
    const id = setInterval(() => void refresh(ac.signal), intervalMs);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [intervalMs, refresh]);

  const filtered = React.useMemo(() => {
    const passing = data.signals.filter((s) => {
      if (directionFilter === "bullish" && s.direction !== "BULLISH") return false;
      if (directionFilter === "bearish" && s.direction !== "BEARISH") return false;
      if (directionFilter === "wait" && s.action !== "WAIT") return false;
      if (horizonFilter !== "all" && s.horizon !== horizonFilter) return false;
      return true;
    });
    // Order by AI conviction so the strongest setups surface first.
    // Confidence is the primary key (the composite confluence score the
    // engine actually publishes); fall back to calibrated win-probability
    // and then blended R:R as deterministic tiebreakers so the order is
    // stable across re-renders. `.slice()` to avoid mutating `data.signals`.
    return passing.slice().sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.winProbability !== a.winProbability) {
        return b.winProbability - a.winProbability;
      }
      return b.riskRewardBlended - a.riskRewardBlended;
    });
  }, [data.signals, directionFilter, horizonFilter]);

  const generatedLabel = new Date(data.generatedAt).toLocaleTimeString();

  const nextSessionLabel = data.context.nextSessionLabel ?? null;
  const nextSessionOpensAt = data.context.nextSessionOpensAt ?? null;

  return (
    <div className="flex flex-col gap-4">
      <AiMarketContextBanner context={data.context} stats={data.stats} />

      {nextSessionLabel && nextSessionOpensAt ? (
        <NextSessionBanner
          label={nextSessionLabel}
          opensAt={nextSessionOpensAt}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="flex flex-wrap gap-1.5">
          {DIRECTION_OPTIONS.map((opt) => {
            const OptIcon = opt.icon;
            const on = directionFilter === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setDirectionFilter(opt.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ring-1 ring-inset",
                  on
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-[var(--color-border-strong)]"
                    : "bg-transparent text-[var(--color-fg-muted)] ring-[var(--color-border)] hover:text-[var(--color-fg)]",
                )}
                aria-pressed={on}
              >
                <OptIcon className="h-3 w-3" />
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={horizonFilter}
            onChange={(e) =>
              setHorizonFilter(e.target.value as AiSignal["horizon"] | "all")
            }
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] outline-none focus:border-[var(--color-border-strong)]"
            aria-label="Filter by horizon"
          >
            {HORIZON_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>

          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {filtered.length} / {data.signals.length}
          </span>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]",
              refreshing && "opacity-60",
            )}
          >
            <RefreshCw
              className={cn("h-3 w-3", refreshing && "animate-spin")}
            />
            Refresh
          </button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        Model {data.modelVersion} · regenerated {generatedLabel} ·{" "}
        {data.context.dataFreshness}
        {error ? (
          <span className="ml-2 text-[var(--color-bear)]">· {error}</span>
        ) : null}
      </p>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-10 text-center text-sm text-[var(--color-fg-muted)]">
          No signals match the current filter. Try widening the filter or
          waiting for the next refresh.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((s) => (
            <AiSignalCard key={s.id} signal={s} currency={currency} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Rendered when the response carries a `nextSessionOpensAt` — i.e. the
 * underlying market is closed and the builder has rebased every signal
 * to the next trading day's open. Tells the user, in one row, that the
 * grid below is a *plan* for that session and ticks down to the bell.
 *
 * SSR contract: `remainingLabel` starts as a static placeholder so server
 * + client agree on the initial HTML — the live countdown only fills in
 * after `useEffect` runs on mount. Avoids a hydration mismatch warning
 * from the `Date.now()` skew between server and client renders.
 */
function NextSessionBanner({
  label,
  opensAt,
}: {
  label: string;
  opensAt: number;
}) {
  const [remainingLabel, setRemainingLabel] = React.useState<string>("…");

  React.useEffect(() => {
    const tick = () => setRemainingLabel(formatCountdown(opensAt - Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [opensAt]);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color-mix(in_oklch,var(--color-info)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-info)_8%,var(--color-bg-elevated))] px-4 py-2.5 text-[12px] text-[var(--color-fg-muted)]"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-bg-elevated)] text-[var(--color-info)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-info)_30%,transparent)]">
          <CalendarClock className="h-3.5 w-3.5" />
        </span>
        <span>
          <span className="font-semibold text-[var(--color-fg)]">
            Market closed
          </span>{" "}
          — these signals are queued for{" "}
          <span className="font-semibold text-[var(--color-fg)]">{label}</span>.
          Plan now, execute at the open.
        </span>
      </div>
      <span className="num inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]">
        Opens in {remainingLabel}
      </span>
    </div>
  );
}

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "moments";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
