"use client";

import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { IndiaScalpSignalCard } from "@/components/india/strategies/india-scalp-signal-card";
import {
  indiaSelectionToParam,
  useIndiaStrategyFilter,
} from "@/components/india/strategies/strategy-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getBestTimeStatus,
  getNextTradingSessionOpen,
  type NextTradingSession,
} from "@/features/india/best-time/engine";
import type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";
import type {
  IndiaScalpSignal,
  IndiaScalpSignalsResponse,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";
import { cn } from "@/lib/utils";

const TIMEFRAMES: IndiaScalpTimeframe[] = ["1m", "5m", "15m"];
const POLL_MS = 30_000;

interface Props {
  initial?: IndiaScalpSignalsResponse;
}

/**
 * India F&O live signals — mirror of the crypto `LiveSignals` component
 * down to the multi-tf chip group + per-(strategy,tf) client-side
 * filtering. Fan-outs one fetch per active timeframe to
 * `/api/in/scalper/signals` so each tf hits its own server cache key.
 *
 * The polling cadence is doubled vs crypto (30s vs 20s) because the
 * NSE option chain backing PCR / IV / OI scanners is itself slower to
 * refresh, and a faster cadence on the client just burns network for
 * the same data.
 */
export function IndiaLiveSignals({ initial }: Props) {
  const { selected, timeframesFor } = useIndiaStrategyFilter();

  const [tfs, setTfs] = useState<Set<IndiaScalpTimeframe>>(
    () => new Set([initial?.timeframe ?? "5m"]),
  );

  const selectedTfList = useMemo(
    () => TIMEFRAMES.filter((t) => tfs.has(t)),
    [tfs],
  );
  const tfLabel = selectedTfList.length > 0 ? selectedTfList.join(" / ") : "—";

  const activeForAnyTf = useMemo<Set<IndiaScalpStrategyId>>(() => {
    const set = new Set<IndiaScalpStrategyId>();
    for (const id of selected) {
      const strategyTfs = timeframesFor(id);
      for (const t of tfs) {
        if (strategyTfs.has(t)) {
          set.add(id);
          break;
        }
      }
    }
    return set;
  }, [selected, timeframesFor, tfs]);

  const isLaneActive = useCallback(
    (strategyId: IndiaScalpStrategyId, timeframe: IndiaScalpTimeframe): boolean => {
      if (!tfs.has(timeframe)) return false;
      return timeframesFor(strategyId).has(timeframe);
    },
    [tfs, timeframesFor],
  );

  const [signals, setSignals] = useState<IndiaScalpSignal[]>(
    initial?.signals ?? [],
  );
  const [generatedAt, setGeneratedAt] = useState<number>(
    () => initial?.generatedAt ?? Date.now(),
  );
  const [loading, setLoading] = useState(false);

  const fetchSignals = useCallback(async () => {
    if (tfs.size === 0) return;
    setLoading(true);
    try {
      const responses = await Promise.all(
        selectedTfList.map(async (timeframe) => {
          const url = new URL(
            "/api/in/scalper/signals",
            window.location.origin,
          );
          url.searchParams.set("timeframe", timeframe);
          const stratsForThisTf = new Set<IndiaScalpStrategyId>();
          for (const id of selected) {
            if (timeframesFor(id).has(timeframe)) stratsForThisTf.add(id);
          }
          const param = indiaSelectionToParam(stratsForThisTf);
          if (param) url.searchParams.set("strategies", param);
          const res = await fetch(url.toString(), { cache: "no-store" });
          if (!res.ok) return null;
          return (await res.json()) as IndiaScalpSignalsResponse;
        }),
      );
      const merged: IndiaScalpSignal[] = [];
      let latest = 0;
      for (const r of responses) {
        if (!r) continue;
        merged.push(...r.signals);
        if (r.generatedAt > latest) latest = r.generatedAt;
      }
      // Primary order: confidence (high → low) so the highest-conviction
      // setups bubble to the top of the grid. Tiebreaker: most recent
      // trigger first, so a freshly-printed signal beats a stale one at
      // the same conviction level.
      merged.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return b.triggeredAt - a.triggeredAt;
      });
      setSignals(merged);
      if (latest > 0) setGeneratedAt(latest);
    } catch {
      // silently ignore — next poll will retry
    } finally {
      setLoading(false);
    }
  }, [tfs, selectedTfList, selected, timeframesFor]);

  useEffect(() => {
    const initialT = setTimeout(() => void fetchSignals(), 0);
    const id = setInterval(() => void fetchSignals(), POLL_MS);
    return () => {
      clearTimeout(initialT);
      clearInterval(id);
    };
  }, [fetchSignals]);

  const visible = useMemo(
    () => signals.filter((s) => isLaneActive(s.strategyId, s.timeframe)),
    [signals, isLaneActive],
  );

  const toggleTf = useCallback((t: IndiaScalpTimeframe) => {
    setTfs((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        if (next.size === 1) return prev;
        next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  }, []);

  const tfsPlural = tfs.size > 1;

  // Re-evaluated every poll (so a session boundary mid-page swaps the
  // banner in / out without a reload). `getBestTimeStatus` is the same
  // pure helper the best-time banner uses — server + client agree on
  // the IST clock so there's no hydration drift.
  const marketStatus = useMarketSessionStatus();

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Live F&amp;O signals
          </CardTitle>
          <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
            {visible.length} {marketStatus.isClosed ? "queued" : "fresh"} ·{" "}
            {activeForAnyTf.size} of {selected.size} strategies on {tfLabel} ·{" "}
            {loading
              ? "Refreshing…"
              : `Updated ${new Date(generatedAt).toLocaleTimeString()}`}
          </p>
        </div>
        <div
          className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5"
          role="group"
          aria-label="Filter signals by timeframe (multi-select)"
        >
          {TIMEFRAMES.map((t) => {
            const on = tfs.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTf(t)}
                aria-pressed={on}
                title={on ? `Hide ${t} signals` : `Show ${t} signals`}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
                  on
                    ? "bg-[var(--color-surface)] text-[var(--color-fg)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-info)_35%,transparent)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent>
        {marketStatus.isClosed && marketStatus.nextSession ? (
          <NextSessionStrip nextSession={marketStatus.nextSession} />
        ) : null}
        {visible.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              {activeForAnyTf.size === 0
                ? `No strategies are attached to the selected timeframe${tfsPlural ? "s" : ""} (${tfLabel}). Open the picker above and toggle a ${selectedTfList.join(" / ")} chip on any strategy to see signals here.`
                : marketStatus.isClosed
                  ? `NSE is closed — the scanners replay the last session's prints. New ${tfLabel} signals for ${marketStatus.nextSession?.dayLabel ?? "the next session"} will print after the ${marketStatus.nextSession?.timeLabel ?? "open"}.`
                  : `No fresh signals on the ${tfLabel} timeframe${tfsPlural ? "s" : ""} from the active strategies right now. The scanners only surface a row when the underlying NSE setup actually fires — quiet sessions produce no rows.`}
            </p>
            {loading ? (
              <Skeleton className="h-[120px] w-full rounded-lg" />
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {visible.map((s) => (
              <IndiaScalpSignalCard
                key={`${s.symbol}-${s.strategyId}-${s.timeframe}-${s.triggeredAt}`}
                signal={s}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface MarketSessionStatus {
  isClosed: boolean;
  nextSession: NextTradingSession | null;
}

const CLOSED_INITIAL: MarketSessionStatus = { isClosed: false, nextSession: null };

/**
 * Tracks whether NSE is currently outside its 09:15–15:30 IST cash window.
 * Ticks once a minute (no need to be finer-grained — the smallest unit the
 * banner cares about is "minutes until open").
 *
 * SSR contract: the server render ALWAYS returns the "open" state so the
 * initial HTML is deterministic and the banner / "queued vs fresh" copy
 * never diverges between SSR and hydration. The real session state is
 * computed inside `useEffect` once the component has mounted on the client
 * — at that point we're free to call `getBestTimeStatus()` which reads the
 * wall clock. This is the standard React-18+ pattern for time-dependent
 * UI and is what `useSyncExternalStore` does under the hood for clocks.
 */
function useMarketSessionStatus(): MarketSessionStatus {
  const [state, setState] = useState<MarketSessionStatus>(CLOSED_INITIAL);

  useEffect(() => {
    const compute = (): MarketSessionStatus => {
      const status = getBestTimeStatus();
      const closed = status.active.slug === "off";
      return {
        isClosed: closed,
        nextSession: closed ? getNextTradingSessionOpen() : null,
      };
    };
    setState(compute());
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const timeoutId = setTimeout(() => {
      setState(compute());
      intervalId = setInterval(() => setState(compute()), 60_000);
    }, msUntilNextMinute);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  return state;
}

/**
 * Compact one-row banner shown above the signal grid when NSE is closed.
 * Explains that the listed signals are queued for the next session's
 * 09:15 IST open and ticks down a coarse "Opens in …" countdown.
 */
function NextSessionStrip({
  nextSession,
}: {
  nextSession: NextTradingSession;
}) {
  // SSR contract: this banner only renders after `useMarketSessionStatus`
  // flips `isClosed` to true on the client (the server always reports
  // "open"), so in practice this component is client-only — but we still
  // initialise with a placeholder string instead of `Date.now()` so the
  // first paint doesn't show a stale countdown for one tick.
  const [remaining, setRemaining] = useState<string>("…");
  useEffect(() => {
    const tick = () =>
      setRemaining(formatRemaining(nextSession.opensAt - Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [nextSession.opensAt]);
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color-mix(in_oklch,var(--color-info)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-info)_8%,var(--color-bg-elevated))] px-3 py-2 text-[12px] text-[var(--color-fg-muted)]"
    >
      <div className="flex items-center gap-2">
        <CalendarClock className="h-3.5 w-3.5 text-[var(--color-info)]" />
        <span>
          <span className="font-semibold text-[var(--color-fg)]">
            NSE closed
          </span>{" "}
          — these signals are queued for{" "}
          <span className="font-semibold text-[var(--color-fg)]">
            {nextSession.dayLabel} at {nextSession.timeLabel}
          </span>
          . Review the setup now, execute at the open.
        </span>
      </div>
      <span className="num inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]">
        Opens in {remaining}
      </span>
    </div>
  );
}

function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "moments";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
