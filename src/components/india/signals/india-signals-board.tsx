"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Activity,
  Expand,
  Flame,
  Gauge,
  PlusCircle,
  Rocket,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/india/ui/button";
import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";
import { fmt, fmtPct } from "@/lib/india/format";
import type { ScannerHit, ScannerResult, ScannerType } from "@/types/india/scanner";

type SourceMeta = {
  id: ScannerType;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  intervalMs: number;
};

const SOURCES: SourceMeta[] = [
  {
    id: "range-expansion",
    label: "Range Expansion",
    hint: "WR8 + bullish trend",
    icon: Expand,
    intervalMs: 60_000,
  },
  {
    id: "momentum",
    label: "Momentum",
    hint: "Top % movers",
    icon: TrendingUp,
    intervalMs: 15_000,
  },
  {
    id: "volume-breakout",
    label: "Volume",
    hint: "≥1.5× 20-day avg",
    icon: Rocket,
    intervalMs: 15_000,
  },
  {
    id: "oi-buildup",
    label: "OI Build-up",
    hint: "Long/short build-up",
    icon: Activity,
    intervalMs: 30_000,
  },
  { id: "pcr", label: "PCR", hint: "Put-Call Ratio", icon: Gauge, intervalMs: 30_000 },
  {
    id: "iv-spike",
    label: "IV Spike",
    hint: "ATM implied vol",
    icon: Flame,
    intervalMs: 30_000,
  },
];

const SOURCE_BY_ID: Record<ScannerType, SourceMeta> = Object.fromEntries(
  SOURCES.map((s) => [s.id, s] as const),
) as Record<ScannerType, SourceMeta>;

type RankedHit = ScannerHit & {
  source: ScannerType;
  rank: number;
  fetchedAt: string;
};

type SourceState = {
  result: ScannerResult | null;
  loading: boolean;
  error: string | null;
};

const STORAGE_KEY = "india-signals-active-sources";

function loadSelection(): Set<ScannerType> {
  if (typeof window === "undefined") return new Set(SOURCES.map((s) => s.id));
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(SOURCES.map((s) => s.id));
    const parsed = JSON.parse(raw) as ScannerType[];
    const all = new Set(SOURCES.map((s) => s.id));
    const filtered = parsed.filter((id): id is ScannerType => all.has(id));
    return filtered.length > 0
      ? new Set(filtered)
      : new Set(SOURCES.map((s) => s.id));
  } catch {
    return new Set(SOURCES.map((s) => s.id));
  }
}

function persistSelection(set: Set<ScannerType>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function kindToneClass(kind?: string): string {
  switch (kind) {
    case "LONG_BUILDUP":
    case "BULLISH":
    case "GAINER":
    case "BULL_VOLUME":
    case "SHORT_COVERING":
    case "RANGE_EXPANSION":
      return "bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)] text-[var(--color-bull)]";
    case "SHORT_BUILDUP":
    case "BEARISH":
    case "LOSER":
    case "BEAR_VOLUME":
    case "LONG_UNWINDING":
      return "bg-[color-mix(in_oklch,var(--color-bear)_15%,transparent)] text-[var(--color-bear)]";
    case "ELEVATED":
      return "bg-[color-mix(in_oklch,var(--color-warning)_15%,transparent)] text-[var(--color-warning)]";
    case "LOW":
      return "bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)]";
    default:
      return "bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]";
  }
}

export function IndiaSignalsBoard() {
  const [active, setActive] = React.useState<Set<ScannerType>>(() => loadSelection());
  const [state, setState] = React.useState<Record<ScannerType, SourceState>>(() =>
    Object.fromEntries(
      SOURCES.map((s) => [s.id, { result: null, loading: false, error: null }]),
    ) as Record<ScannerType, SourceState>,
  );
  const addToWatchlist = useIndiaWatchlistStore((s) => s.add);

  React.useEffect(() => {
    persistSelection(active);
  }, [active]);

  // One effect that fans out a poll-loop per active source. Each source has
  // its own AbortController + interval so flipping a source off (or
  // unmounting) cancels just its in-flight fetch.
  React.useEffect(() => {
    const cancellers: Array<() => void> = [];

    for (const meta of SOURCES) {
      if (!active.has(meta.id)) continue;
      let cancelled = false;
      const ac = new AbortController();

      const run = async () => {
        setState((s) => ({
          ...s,
          [meta.id]: { ...s[meta.id], loading: true },
        }));
        try {
          const res = await fetch(
            `/api/in/scanner?type=${encodeURIComponent(meta.id)}&limit=15`,
            { signal: ac.signal, cache: "no-store" },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as ScannerResult;
          if (cancelled) return;
          setState((s) => ({
            ...s,
            [meta.id]: { result: data, loading: false, error: null },
          }));
        } catch (e) {
          if (cancelled || ac.signal.aborted) return;
          const msg = e instanceof Error ? e.message : "Failed";
          setState((s) => ({
            ...s,
            [meta.id]: { ...s[meta.id], loading: false, error: msg },
          }));
        }
      };

      void run();
      const intervalId = setInterval(() => void run(), meta.intervalMs);
      cancellers.push(() => {
        cancelled = true;
        ac.abort();
        clearInterval(intervalId);
      });
    }

    return () => {
      for (const c of cancellers) c();
    };
  }, [active]);

  const merged = React.useMemo<RankedHit[]>(() => {
    const out: RankedHit[] = [];
    for (const meta of SOURCES) {
      if (!active.has(meta.id)) continue;
      const r = state[meta.id]?.result;
      if (!r) continue;
      r.hits.forEach((h, i) => {
        out.push({ ...h, source: meta.id, rank: i + 1, fetchedAt: r.fetchedAt });
      });
    }
    // Rank by metric magnitude (so the strongest signals across the merged
    // set bubble up). Fall back to rank-within-source when metric is equal.
    return out.sort((a, b) => {
      const am = Math.abs(a.metric ?? 0);
      const bm = Math.abs(b.metric ?? 0);
      if (am === bm) return a.rank - b.rank;
      return bm - am;
    });
  }, [active, state]);

  const toggle = (id: ScannerType) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Don't allow disabling everything — keep at least one source on so the
      // page is never blank.
      if (next.size === 0) next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Signal sources
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {SOURCES.map((meta) => {
              const Icon = meta.icon;
              const on = active.has(meta.id);
              const s = state[meta.id];
              const count = s?.result?.hits.length ?? 0;
              return (
                <button
                  key={meta.id}
                  onClick={() => toggle(meta.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ring-1 ring-inset ${
                    on
                      ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-[var(--color-border-strong)]"
                      : "bg-transparent text-[var(--color-fg-muted)] ring-[var(--color-border)] hover:text-[var(--color-fg)]"
                  }`}
                  aria-pressed={on}
                >
                  <Icon className="h-3 w-3" />
                  {meta.label}
                  <span className="text-[10px] text-[var(--color-fg-subtle)]">
                    {meta.hint}
                  </span>
                  {on && count > 0 && (
                    <span className="ml-1 rounded-full bg-[var(--color-bg-elevated)] px-1.5 text-[10px]">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
              <span className="inline-flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[var(--color-brand)]" />
                Live F&amp;O signals
              </span>
            </CardTitle>
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              {merged.length} signal{merged.length === 1 ? "" : "s"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                <th className="py-2 pr-3 font-medium">Source</th>
                <th className="py-2 pr-3 font-medium">Symbol</th>
                <th className="py-2 pr-3 text-right font-medium">Price</th>
                <th className="py-2 pr-3 text-right font-medium">Day %</th>
                <th className="py-2 pr-3 text-right font-medium">Metric</th>
                <th className="py-2 pr-3 font-medium">Tag</th>
                <th className="py-2 pr-3 font-medium">Note</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {merged.map((h, i) => {
                const meta = SOURCE_BY_ID[h.source];
                const Icon = meta.icon;
                const up = (h.changePct ?? 0) >= 0;
                return (
                  <motion.tr
                    key={`${h.source}:${h.symbol}:${i}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.01, 0.3) }}
                    className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-medium">
                      <Link
                        href={`/in/chart/${encodeURIComponent(h.symbol)}`}
                        className="text-[var(--color-brand)] hover:underline"
                      >
                        {h.symbol}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 tabular text-right">
                      {fmt(h.price)}
                    </td>
                    <td
                      className={`py-2 pr-3 tabular text-right font-medium ${
                        up ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"
                      }`}
                    >
                      {h.changePct == null ? "—" : fmtPct(h.changePct)}
                    </td>
                    <td className="py-2 pr-3 tabular text-right font-semibold">
                      {h.metricLabel}
                    </td>
                    <td className="py-2 pr-3">
                      {h.kind && (
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${kindToneClass(String(h.kind))}`}
                        >
                          {String(h.kind).replace("_", " ")}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[280px] truncate py-2 pr-3 text-[12px] text-[var(--color-fg-muted)]">
                      {h.note ?? ""}
                    </td>
                    <td className="py-2">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => addToWatchlist(h.symbol)}
                        title="Add to watchlist"
                      >
                        <PlusCircle className="h-3 w-3 mr-1" />
                        Watch
                      </Button>
                    </td>
                  </motion.tr>
                );
              })}
              {merged.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="py-8 text-center text-sm text-[var(--color-fg-muted)]"
                  >
                    {SOURCES.some((m) => state[m.id]?.loading)
                      ? "Loading scanners…"
                      : "No active signals — try selecting another source."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
