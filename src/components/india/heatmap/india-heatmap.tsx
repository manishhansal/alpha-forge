"use client";

import Link from "next/link";
import * as React from "react";
import { motion } from "framer-motion";
import { Flame, RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/india/ui/button";
import { fmt, fmtPct } from "@/lib/india/format";

type SectorRow = {
  symbol: string;
  shortName: string | null;
  price: number | null;
  changePct: number | null;
};

type SectorData = {
  name: string;
  rows: SectorRow[];
  loading: boolean;
  error: string | null;
  fetchedAt: string | null;
  avgChangePct: number | null;
};

interface IndiaHeatmapProps {
  sectors: { name: string; symbols: string[] }[];
}

/**
 * Resolves a tile's tint, ring and text colour from the day-% change.
 * Returns inline styles instead of Tailwind classes because the saturation
 * scales continuously with `pct` — Tailwind's JIT can't generate arbitrary
 * `color-mix` percentages from a template literal.
 */
function tintFromPct(pct: number | null | undefined): React.CSSProperties {
  if (pct == null) {
    return {
      backgroundColor: "var(--color-surface-hover)",
      color: "var(--color-fg-muted)",
      boxShadow: "inset 0 0 0 1px var(--color-border)",
    };
  }
  const clamped = Math.max(-5, Math.min(5, pct));
  const intensity = Math.abs(clamped) / 5;
  const bgPct = Math.round(intensity * 38);
  const ringPct = Math.round(intensity * 32);
  if (clamped > 0) {
    return {
      backgroundColor: `color-mix(in oklch, var(--color-bull) ${bgPct}%, transparent)`,
      color: "var(--color-bull)",
      boxShadow: `inset 0 0 0 1px color-mix(in oklch, var(--color-bull) ${ringPct}%, transparent)`,
    };
  }
  if (clamped < 0) {
    return {
      backgroundColor: `color-mix(in oklch, var(--color-bear) ${bgPct}%, transparent)`,
      color: "var(--color-bear)",
      boxShadow: `inset 0 0 0 1px color-mix(in oklch, var(--color-bear) ${ringPct}%, transparent)`,
    };
  }
  return {
    backgroundColor: "var(--color-surface-hover)",
    color: "var(--color-fg-muted)",
    boxShadow: "inset 0 0 0 1px var(--color-border)",
  };
}

function tileSize(rowsCount: number): { col: string; row: string } {
  // Bigger sectors get more columns; this keeps the grid roughly square.
  const cols = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(rowsCount))));
  return {
    col: `repeat(${cols}, minmax(0, 1fr))`,
    row: "auto",
  };
}

export function IndiaHeatmap({ sectors }: IndiaHeatmapProps) {
  const [data, setData] = React.useState<Record<string, SectorData>>(() =>
    Object.fromEntries(
      sectors.map((s) => [
        s.name,
        {
          name: s.name,
          rows: [],
          loading: true,
          error: null,
          fetchedAt: null,
          avgChangePct: null,
        },
      ]),
    ),
  );

  const fetchSector = React.useCallback(async (name: string) => {
    setData((d) => ({
      ...d,
      [name]: { ...d[name], loading: true, error: null },
    }));
    try {
      const res = await fetch(
        `/api/in/sector-stocks?sector=${encodeURIComponent(name)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        rows: SectorRow[];
        fetchedAt?: string;
      };
      const rows = (json.rows ?? []).map((r) => ({
        symbol: r.symbol,
        shortName: r.shortName ?? null,
        price: r.price ?? null,
        changePct: r.changePct ?? null,
      }));
      const valid = rows.filter((r) => r.changePct != null);
      const avg =
        valid.length > 0
          ? valid.reduce((a, r) => a + (r.changePct ?? 0), 0) / valid.length
          : null;
      setData((d) => ({
        ...d,
        [name]: {
          name,
          rows,
          loading: false,
          error: null,
          fetchedAt: json.fetchedAt ?? new Date().toISOString(),
          avgChangePct: avg,
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      setData((d) => ({
        ...d,
        [name]: { ...d[name], loading: false, error: msg },
      }));
    }
  }, []);

  // Stagger initial loads so we don't hammer Yahoo with 11 parallel sectors.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const s of sectors) {
        if (cancelled) return;
        await fetchSector(s.name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sectors, fetchSector]);

  const refreshAll = React.useCallback(() => {
    sectors.forEach((s) => {
      void fetchSector(s.name);
    });
  }, [sectors, fetchSector]);

  // Sort sectors by average change so leaders bubble up.
  const ordered = React.useMemo(() => {
    return [...sectors]
      .map((s) => ({ ...s, ...data[s.name] }))
      .sort((a, b) => {
        const av = a.avgChangePct ?? -999;
        const bv = b.avgChangePct ?? -999;
        return bv - av;
      });
  }, [sectors, data]);

  const allLoading = ordered.every((s) => s.loading);

  return (
    <div className="flex flex-col gap-4">
      <SectorStrip
        sectors={ordered.map((s) => ({
          name: s.name,
          avgChangePct: s.avgChangePct,
          count: s.rows.length || s.symbols.length,
        }))}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
          <Flame className="h-4 w-4 text-[var(--color-bear)]" />
          {allLoading
            ? "Loading sector heatmap…"
            : `${ordered.length} sectors · sorted by today's average move`}
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={refreshAll}
          aria-label="Refresh"
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {ordered.map((s) => (
          <SectorCard
            key={s.name}
            name={s.name}
            rows={s.rows}
            loading={s.loading}
            error={s.error}
            avgChangePct={s.avgChangePct}
          />
        ))}
      </div>
    </div>
  );
}

function SectorStrip({
  sectors,
}: {
  sectors: { name: string; avgChangePct: number | null; count: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Sector pulse
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {sectors.map((s) => (
            <div
              key={s.name}
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium"
              style={tintFromPct(s.avgChangePct)}
            >
              <span className="text-[var(--color-fg)]">{s.name}</span>
              <span className="tabular">
                {s.avgChangePct == null ? "—" : fmtPct(s.avgChangePct)}
              </span>
              <span className="text-[10px] text-[var(--color-fg-subtle)]">
                {s.count}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SectorCard({
  name,
  rows,
  loading,
  error,
  avgChangePct,
}: {
  name: string;
  rows: SectorRow[];
  loading: boolean;
  error: string | null;
  avgChangePct: number | null;
}) {
  const sorted = React.useMemo(
    () =>
      [...rows].sort((a, b) => {
        const av = a.changePct ?? -999;
        const bv = b.changePct ?? -999;
        return bv - av;
      }),
    [rows],
  );

  const grid = tileSize(Math.max(sorted.length, 4));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            {name}
          </CardTitle>
          <span
            className={`text-[12px] font-semibold tabular ${
              avgChangePct == null
                ? "text-[var(--color-fg-muted)]"
                : avgChangePct >= 0
                  ? "text-[var(--color-bull)]"
                  : "text-[var(--color-bear)]"
            }`}
          >
            avg {avgChangePct == null ? "—" : fmtPct(avgChangePct)}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="text-[12px] text-[var(--color-bear)]">{error}</div>
        )}
        {loading && rows.length === 0 && (
          <div className="text-[12px] text-[var(--color-fg-muted)]">
            Loading {name}…
          </div>
        )}
        {!loading && sorted.length === 0 && !error && (
          <div className="text-[12px] text-[var(--color-fg-muted)]">
            No constituents.
          </div>
        )}
        {sorted.length > 0 && (
          <div
            className="grid gap-1.5"
            style={{
              gridTemplateColumns: grid.col,
            }}
          >
            {sorted.map((r) => (
              <Link
                key={r.symbol}
                href={`/in/chart/${encodeURIComponent(r.symbol)}`}
                title={`${r.symbol} · ${r.shortName ?? ""}`}
                className="block"
              >
                <motion.div
                  whileHover={{ scale: 1.04 }}
                  className="flex flex-col items-center justify-center rounded-md px-2 py-2 transition-colors"
                  style={tintFromPct(r.changePct)}
                >
                  <span className="text-[11px] font-semibold leading-none truncate w-full text-center">
                    {r.symbol}
                  </span>
                  <span className="mt-0.5 text-[10px] tabular leading-none">
                    {r.changePct == null ? "—" : fmtPct(r.changePct, 1)}
                  </span>
                  <span className="mt-0.5 text-[9px] tabular text-[var(--color-fg-subtle)] leading-none">
                    {fmt(r.price, 1)}
                  </span>
                </motion.div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
