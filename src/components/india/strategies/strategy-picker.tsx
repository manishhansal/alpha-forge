"use client";

import { Check, Sparkles } from "lucide-react";

import { IndiaStrategyScoreBadge } from "@/components/india/strategies/india-strategy-score-badge";
import { useIndiaStrategyFilter } from "@/components/india/strategies/strategy-context";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  INDIA_SCALP_STRATEGY_CATALOG,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import type { IndiaStrategyScore } from "@/features/india/scalping/strategy-score";
import { INDIA_SCALP_TIMEFRAMES } from "@/features/india/scalping/types";
import { cn } from "@/lib/utils";

interface IndiaStrategyPickerProps {
  /** Per-strategy paper-trade scores, computed server-side from the
   *  journal. Strategies with no closed trades are absent → the chip
   *  renders its neutral "no trades yet" placeholder. */
  scores?: Partial<Record<IndiaScalpStrategyId, IndiaStrategyScore>>;
}

/**
 * Multi-select picker for the active India F&O strategies. Mirrors the
 * crypto `StrategyPicker` 1:1 in layout — strategy chips with monogram,
 * label, description, tags, per-strategy 1m / 5m / 15m toggles, and the
 * paper-trade score chip (fed from the F&O paper-trader's journal record).
 */
export function IndiaStrategyPicker({ scores }: IndiaStrategyPickerProps = {}) {
  const { selected, toggle, toggleTimeframe, timeframesFor, selectAll } =
    useIndiaStrategyFilter();
  const allOn = selected.size === INDIA_SCALP_STRATEGY_CATALOG.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Strategies
          </CardTitle>
          <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
            Toggle which F&amp;O strategies you want signals and paper
            trades for. {selected.size} of{" "}
            {INDIA_SCALP_STRATEGY_CATALOG.length} active.
          </p>
        </div>
        <button
          type="button"
          onClick={selectAll}
          disabled={allOn}
          className={cn(
            "rounded-md border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
            allOn
              ? "border-[var(--color-border)] text-[var(--color-fg-subtle)] opacity-60"
              : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]",
          )}
        >
          Select all
        </button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {INDIA_SCALP_STRATEGY_CATALOG.map((s) => {
            const isOn = selected.has(s.id);
            const activeTfs = timeframesFor(s.id);
            return (
              <div
                key={s.id}
                className={cn(
                  "group relative flex flex-col gap-2 rounded-xl border bg-[var(--color-surface)] p-3 transition-colors",
                  isOn
                    ? "border-[color-mix(in_oklch,var(--color-info)_45%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-info)_25%,transparent)]"
                    : "border-[var(--color-border)] opacity-70 hover:opacity-100 hover:border-[color-mix(in_oklch,var(--color-fg)_25%,transparent)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(s.id)}
                  aria-pressed={isOn}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded-full text-[12px] font-semibold ring-1 ring-inset",
                        isOn
                          ? "bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)] ring-[color-mix(in_oklch,var(--color-info)_30%,transparent)]"
                          : "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] ring-[var(--color-border)]",
                      )}
                    >
                      {s.monogram}
                    </span>
                    <div className="flex flex-col">
                      <span className="text-[13px] font-semibold text-[var(--color-fg)]">
                        {s.label}
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                        {s.category}
                      </span>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "grid h-5 w-5 place-items-center rounded-full border transition-colors",
                      isOn
                        ? "border-[var(--color-info)] bg-[var(--color-info)] text-[var(--color-bg)]"
                        : "border-[var(--color-border)] text-transparent",
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                </button>

                <p className="line-clamp-3 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                  {s.description}
                </p>

                <div className="flex flex-wrap gap-1">
                  {s.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px]">
                      {t}
                    </Badge>
                  ))}
                </div>

                <div
                  className="mt-1 flex items-center gap-2 border-t border-[var(--color-border)] pt-2"
                  title={
                    isOn
                      ? "Toggle which timeframes to paper-trade this strategy on"
                      : "Pick a timeframe to activate this strategy"
                  }
                >
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                    Timeframes
                  </span>
                  <div className="flex items-center gap-1">
                    {INDIA_SCALP_TIMEFRAMES.map((tf) => {
                      const on = activeTfs.has(tf);
                      return (
                        <button
                          key={tf}
                          type="button"
                          onClick={() => toggleTimeframe(s.id, tf)}
                          aria-pressed={on}
                          className={cn(
                            "rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                            on
                              ? "bg-[color-mix(in_oklch,var(--color-info)_18%,transparent)] text-[var(--color-info)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-info)_35%,transparent)]"
                              : "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)] hover:text-[var(--color-fg)]",
                          )}
                        >
                          {tf}
                        </button>
                      );
                    })}
                  </div>
                  <IndiaStrategyScoreBadge
                    score={scores?.[s.id]}
                    compact
                    className="ml-auto"
                  />
                </div>

                {isOn ? (
                  <Sparkles className="absolute right-3 top-3 h-3 w-3 text-[var(--color-info)] opacity-0 transition-opacity group-hover:opacity-100" />
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
