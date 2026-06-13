"use client";

import { useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SECTOR_ORDER, type Sector } from "@/features/heatmap/sectors";
import type { CoinTile } from "@/features/heatmap/aggregate";
import { cn, formatCompact, formatPercent, formatPrice } from "@/lib/utils";

interface CoinGridProps {
  tiles: CoinTile[];
}

type SortMode = "volume" | "gainers" | "losers";

const SORT_OPTIONS: { id: SortMode; label: string }[] = [
  { id: "volume", label: "Volume" },
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
];

/**
 * Maps a 24h change % to a Tailwind class via discrete bins. We don't use
 * inline `color-mix(...)` inline styles per tile because that defeats CSS
 * caching and each tile would re-paint on hover. The bins approximate a
 * green→red gradient and are perceptually monotone.
 */
function changeBg(pct: number): string {
  if (!Number.isFinite(pct)) return "bg-[var(--color-surface)] text-[var(--color-fg-muted)]";
  if (pct >= 8) return "bg-[color-mix(in_oklch,var(--color-bull)_60%,transparent)] text-white";
  if (pct >= 4) return "bg-[color-mix(in_oklch,var(--color-bull)_42%,transparent)] text-white";
  if (pct >= 1.5) return "bg-[color-mix(in_oklch,var(--color-bull)_26%,transparent)] text-[var(--color-bull)]";
  if (pct >= 0.3) return "bg-[color-mix(in_oklch,var(--color-bull)_14%,transparent)] text-[var(--color-bull)]";
  if (pct > -0.3) return "bg-[var(--color-surface)] text-[var(--color-fg-muted)]";
  if (pct > -1.5) return "bg-[color-mix(in_oklch,var(--color-bear)_14%,transparent)] text-[var(--color-bear)]";
  if (pct > -4) return "bg-[color-mix(in_oklch,var(--color-bear)_26%,transparent)] text-[var(--color-bear)]";
  if (pct > -8) return "bg-[color-mix(in_oklch,var(--color-bear)_42%,transparent)] text-white";
  return "bg-[color-mix(in_oklch,var(--color-bear)_60%,transparent)] text-white";
}

/** Coarse 4-step area scale: weight ∈ [0,1] → grid-row/col span. */
function tileSpan(weight: number): { col: 1 | 2; row: 1 | 2 } {
  if (weight >= 0.85) return { col: 2, row: 2 };
  if (weight >= 0.6) return { col: 2, row: 1 };
  return { col: 1, row: 1 };
}

export function CoinGrid({ tiles }: CoinGridProps) {
  const [sort, setSort] = useState<SortMode>("volume");
  const [sectorFilter, setSectorFilter] = useState<Sector | "All">("All");

  const visible = useMemo(() => {
    let list = tiles;
    if (sectorFilter !== "All") list = list.filter((t) => t.sector === sectorFilter);
    switch (sort) {
      case "gainers":
        return [...list].sort((a, b) => b.changePct - a.changePct);
      case "losers":
        return [...list].sort((a, b) => a.changePct - b.changePct);
      default:
        return list;
    }
  }, [tiles, sort, sectorFilter]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Coin performance · 24h</CardTitle>
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Binance USDT perpetuals · top {tiles.length} by quote volume · tile size ∝ log(volume).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1">
              {SORT_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setSort(o.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                    o.id === sort
                      ? "bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm"
                      : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <select
              value={sectorFilter}
              onChange={(e) => setSectorFilter(e.target.value as Sector | "All")}
              className="h-7 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-[11px] text-[var(--color-fg)] focus:outline-none"
              aria-label="Filter by sector"
            >
              <option value="All">All sectors</option>
              {SECTOR_ORDER.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="py-12 text-center text-[12px] text-[var(--color-fg-muted)]">
            No tickers match the current filter.
          </p>
        ) : (
          <div
            className="grid auto-rows-[64px] gap-1.5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
          >
            {visible.map((t) => {
              const span = tileSpan(t.weight);
              return (
                <div
                  key={t.symbol}
                  className={cn(
                    "group relative flex flex-col justify-between rounded-md px-2 py-1.5 transition-transform hover:scale-[1.02]",
                    changeBg(t.changePct),
                  )}
                  style={{
                    gridColumn: `span ${span.col} / span ${span.col}`,
                    gridRow: `span ${span.row} / span ${span.row}`,
                  }}
                  title={`${t.symbol} · vol $${formatCompact(t.quoteVolume)}`}
                >
                  <div className="flex items-baseline justify-between gap-1.5">
                    <span className="truncate text-[11px] font-semibold tracking-tight">
                      {t.display}
                    </span>
                    <Badge variant="outline" className="px-1 py-0 text-[9px]">
                      {t.sector}
                    </Badge>
                  </div>
                  <div className="num text-right text-[12px] font-medium tabular-nums">
                    {formatPercent(t.changePct)}
                  </div>
                  <div className="num text-right text-[10px] opacity-70">
                    ${formatPrice(t.price)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
