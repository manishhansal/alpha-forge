"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ScalpSignalCard } from "@/components/scalper/scalp-signal-card";
import {
  selectionToParam,
  useStrategyFilter,
} from "@/components/scalper/strategy-context";
import type { ScalpStrategyId } from "@/features/scalping/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  ScalpSignal,
  ScalpSignalsResponse,
  ScalpTimeframe,
} from "@/features/scalping/types";

const TIMEFRAMES: ScalpTimeframe[] = ["1m", "5m", "15m"];
const POLL_MS = 20_000;

interface Props {
  initial?: ScalpSignalsResponse;
}

export function LiveSignals({ initial }: Props) {
  const { selected, timeframesFor } = useStrategyFilter();

  // Multi-select timeframe filter. Initialised to the SSR-rendered
  // timeframe so first paint matches the server response, then the user
  // can opt-in to additional lanes — e.g. show 1m AND 5m at once.
  const [tfs, setTfs] = useState<Set<ScalpTimeframe>>(
    () => new Set([initial?.timeframe ?? "5m"]),
  );

  const selectedTfList = useMemo(
    () => TIMEFRAMES.filter((t) => tfs.has(t)),
    [tfs],
  );
  const tfLabel = selectedTfList.length > 0 ? selectedTfList.join(" / ") : "—";

  // Strategies that have AT LEAST ONE of the selected timeframes attached
  // — drives the empty-state copy and the "X of Y strategies" caption.
  const activeForAnyTf = useMemo<Set<ScalpStrategyId>>(() => {
    const set = new Set<ScalpStrategyId>();
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

  // (strategyId, timeframe) pair-level filter. Used as a client-side
  // safety net — the cached server response can still contain rows whose
  // lane has since been toggled off in the picker.
  const isLaneActive = useCallback(
    (strategyId: ScalpStrategyId, timeframe: ScalpTimeframe): boolean => {
      if (!tfs.has(timeframe)) return false;
      return timeframesFor(strategyId).has(timeframe);
    },
    [tfs, timeframesFor],
  );

  const [signals, setSignals] = useState<ScalpSignal[]>(initial?.signals ?? []);
  // Lazy initialiser keeps the impure `Date.now()` call out of render.
  const [generatedAt, setGeneratedAt] = useState<number>(
    () => initial?.generatedAt ?? Date.now(),
  );
  const [loading, setLoading] = useState(false);

  const fetchSignals = useCallback(async () => {
    if (tfs.size === 0) return;
    setLoading(true);
    try {
      // Fan out one request per selected timeframe — each timeframe has
      // its own Redis cache key on the server, so parallel calls reuse
      // the cache instead of forcing a new compute path.
      const responses = await Promise.all(
        selectedTfList.map(async (timeframe) => {
          const url = new URL("/api/scalper/signals", window.location.origin);
          url.searchParams.set("timeframe", timeframe);
          // Per-tf strategy filter — only ask for strategies that
          // actually have THIS timeframe attached, so the response is
          // the slimmest possible.
          const stratsForThisTf = new Set<ScalpStrategyId>();
          for (const id of selected) {
            if (timeframesFor(id).has(timeframe)) stratsForThisTf.add(id);
          }
          const param = selectionToParam(stratsForThisTf);
          if (param) url.searchParams.set("strategies", param);
          const res = await fetch(url.toString(), { cache: "no-store" });
          if (!res.ok) return null;
          return (await res.json()) as ScalpSignalsResponse;
        }),
      );
      const merged: ScalpSignal[] = [];
      let latest = 0;
      for (const r of responses) {
        if (!r) continue;
        merged.push(...r.signals);
        if (r.generatedAt > latest) latest = r.generatedAt;
      }
      // Newest signals first across the merged timeframes.
      merged.sort((a, b) => b.triggeredAt - a.triggeredAt);
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

  const toggleTf = useCallback((t: ScalpTimeframe) => {
    setTfs((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        // Always keep at least one tf selected — otherwise the section
        // silently renders empty with no obvious recovery.
        if (next.size === 1) return prev;
        next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  }, []);

  const tfsPlural = tfs.size > 1;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Live scalp signals
          </CardTitle>
          <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
            {visible.length} fresh · {activeForAnyTf.size} of {selected.size}{" "}
            strategies on {tfLabel} ·{" "}
            {loading ? "Refreshing…" : `Updated ${new Date(generatedAt).toLocaleTimeString()}`}
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
        {visible.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              {activeForAnyTf.size === 0
                ? `No strategies are attached to the selected timeframe${tfsPlural ? "s" : ""} (${tfLabel}). Open the picker above and toggle a ${selectedTfList.join(" / ")} chip on any strategy to see signals here.`
                : `No fresh signals on the ${tfLabel} timeframe${tfsPlural ? "s" : ""} from the active strategies right now. The engines report a signal only on the bar they flip — quiet ranges produce no rows.`}
            </p>
            {loading ? <Skeleton className="h-[120px] w-full rounded-lg" /> : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {visible.map((s) => (
              <ScalpSignalCard
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
