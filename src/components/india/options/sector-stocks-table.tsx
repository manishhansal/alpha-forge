"use client";

/**
 * SectorStocksTable
 *
 * TanStack Table v9 implementation of the sector-stocks data table.
 * Replaces the hand-rolled sorted table in SectorStocksModal.
 *
 * Features:
 *   • Server-side data, client-side sorting via rowSortingFeature
 *   • All columns sortable — click header to toggle asc/desc
 *   • ScorePill, signal badge, age badge rendered as cell components
 *   • Responsive: symbol/price/day/signal always visible;
 *     extended columns hidden on narrow viewports
 */

import * as React from "react";
import {
  useTable,
  createColumnHelper,
  flexRender,
  coreFeatures,
  rowSortingFeature,
  createSortedRowModel,
  tableFeatures,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

/* ── Types (mirrors msb-dashboard local type) ────────────────────────────── */

export type StockRow = {
  symbol: string;
  shortName: string | null;
  price: number | null;
  changePct: number | null;
  sma50: number | null;
  high52w: number | null;
  low52w: number | null;
  targetMean: number | null;
  fromSma50Pct: number | null;
  upsidePct: number | null;
  downsidePct: number | null;
  signal: "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL" | "N/A";
  score: number;
  signalSince?: number | null;
  /** Computed externally: ms since signal was first seen. */
  ageMs?: number | null;
  ageSource?: "server" | "local" | null;
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const fmt = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d);

function PctCell({ value }: { value: number | null | undefined }) {
  if (value == null || Number.isNaN(value))
    return <span className="opacity-40 num">—</span>;
  const up = value >= 0;
  return (
    <span className={cn("num font-medium", up ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]")}>
      {up ? "+" : ""}{value.toFixed(2)}%
    </span>
  );
}

function ScorePill({ score }: { score: number }) {
  const clamped  = Math.max(-100, Math.min(100, score));
  const positive = clamped >= 0;
  const widthPct = Math.abs(clamped);
  return (
    <div className="inline-flex items-center gap-2 justify-end">
      <span className={cn("text-xs font-bold num", positive ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]")}>
        {clamped > 0 ? "+" : ""}{clamped}
      </span>
      <div className="relative h-1.5 w-10 rounded-full bg-[var(--color-surface)] overflow-hidden">
        <div
          className={cn("absolute top-0 bottom-0 rounded-full", positive ? "bg-[var(--color-bull)]" : "bg-[var(--color-bear)]")}
          style={{
            width: `${widthPct / 2}%`,
            left: positive ? "50%" : `${50 - widthPct / 2}%`,
            boxShadow: positive ? "0 0 6px var(--glow-bull)" : "0 0 6px var(--glow-bear)",
          }}
        />
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--color-border)]" />
      </div>
    </div>
  );
}

const SIGNAL_CLS: Record<StockRow["signal"], string> = {
  "STRONG BUY":  "bg-[color-mix(in_oklch,var(--bull)_80%,black)] text-white shadow-[0_0_8px_var(--glow-bull)]",
  "BUY":         "bg-[color-mix(in_oklch,var(--bull)_15%,transparent)] text-[var(--color-bull)] border border-[color-mix(in_oklch,var(--bull)_30%,transparent)]",
  "HOLD":        "bg-[var(--color-surface)] text-[var(--color-fg-muted)]",
  "SELL":        "bg-[color-mix(in_oklch,var(--bear)_15%,transparent)] text-[var(--color-bear)] border border-[color-mix(in_oklch,var(--bear)_30%,transparent)]",
  "STRONG SELL": "bg-[color-mix(in_oklch,var(--bear)_80%,black)] text-white shadow-[0_0_8px_var(--glow-bear)]",
  "N/A":         "bg-[var(--color-surface)]/50 text-[var(--color-fg-subtle)]",
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/* ── Column helper ───────────────────────────────────────────────────────── */

const features = tableFeatures({
  ...coreFeatures,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});
type TFeatures = typeof features;

const columnHelper = createColumnHelper<TFeatures, StockRow>();

// Cast to the wide ColumnDef array so mixed accessor types don't conflict
const columns: ColumnDef<TFeatures, StockRow>[] = [
  columnHelper.accessor("symbol", {
    header: "Symbol",
    enableSorting: true,
    cell: (info) => {
      const row = info.row.original;
      return (
        <div>
          <a
            href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${row.symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[var(--color-brand)] hover:underline transition-colors"
          >
            {row.symbol}
          </a>
          {row.shortName && (
            <div className="text-[10px] text-[var(--color-fg-muted)] truncate max-w-[160px]">
              {row.shortName}
            </div>
          )}
        </div>
      );
    },
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("price", {
    header: "Price",
    enableSorting: true,
    cell: (info) => (
      <span className="num text-[var(--color-fg)]">{fmt(info.getValue() as number | null)}</span>
    ),
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("changePct", {
    header: "Day %",
    enableSorting: true,
    cell: (info) => <PctCell value={info.getValue() as number | null} />,
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("fromSma50Pct", {
    header: "vs SMA50",
    enableSorting: true,
    cell: (info) => <PctCell value={info.getValue() as number | null} />,
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("upsidePct", {
    header: "Upside",
    enableSorting: true,
    cell: (info) => {
      const v = info.getValue() as number | null;
      if (v == null) return <span className="opacity-40">—</span>;
      return <span className="num font-medium text-[var(--color-bull)]">+{v.toFixed(1)}%</span>;
    },
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("downsidePct", {
    header: "Downside",
    enableSorting: true,
    cell: (info) => {
      const v = info.getValue() as number | null;
      if (v == null) return <span className="opacity-40">—</span>;
      return <span className="num font-medium text-[var(--color-bear)]">-{v.toFixed(1)}%</span>;
    },
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("score", {
    header: "Score",
    enableSorting: true,
    cell: (info) => <ScorePill score={info.getValue() as number} />,
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("signal", {
    header: "Signal",
    enableSorting: true,
    cell: (info) => {
      const row  = info.row.original;
      const sig  = info.getValue() as StockRow["signal"];
      const isStrong = sig === "STRONG BUY" || sig === "STRONG SELL";
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn("text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap", SIGNAL_CLS[sig])}>
            {sig}
          </span>
          {isStrong && row.ageMs != null && (
            <span
              className={cn("text-[10px] num", sig === "STRONG BUY" ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]")}
              title={row.ageSource === "local" ? "local observation only" : "server snapshot log"}
            >
              {formatDuration(row.ageMs)}
              {row.ageSource === "local" && <span className="opacity-60">*</span>}
            </span>
          )}
        </div>
      );
    },
  }) as unknown as ColumnDef<TFeatures, StockRow>,

  columnHelper.accessor("ageMs", {
    header: "Held for",
    enableSorting: true,
    cell: (info) => {
      const row = info.row.original;
      const ms  = info.getValue() as number | null;
      if (ms == null) return <span className="opacity-40">—</span>;
      const sig = row.signal;
      const tone = sig === "STRONG BUY"
        ? "text-[var(--color-bull)]"
        : sig === "STRONG SELL"
          ? "text-[var(--color-bear)]"
          : "text-[var(--color-fg-muted)]";
      return (
        <span className={cn("num text-xs font-medium", tone)}>
          {formatDuration(ms)}
          {row.ageSource === "local" && <span className="ml-0.5 opacity-60">*</span>}
        </span>
      );
    },
  }) as unknown as ColumnDef<TFeatures, StockRow>,
];

/* ── Table component ─────────────────────────────────────────────────────── */

export interface SectorStocksTableProps {
  rows: StockRow[];
  loading?: boolean;
}

export function SectorStocksTable({ rows, loading = false }: SectorStocksTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "changePct", desc: true },
  ]);

  const table = useTable(
    {
      features,
      columns,
      data: rows,
      state: { sorting },
      onSortingChange: setSorting,
      getRowId: (row) => row.symbol,
    },
    (state) => ({ sorting: state.sorting }),
  );

  const headerGroups = table.getHeaderGroups();
  const tableRows    = table.getSortedRowModel().rows;

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-[var(--color-bg-elevated)]/95 backdrop-blur border-b border-[var(--color-border)]">
          {headerGroups.map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted  = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className={cn(
                      "p-2.5 select-none text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]",
                      header.id !== "symbol" && "text-right",
                    )}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex items-center gap-1 transition-colors hover:text-[var(--color-fg)]",
                          sorted ? "text-[var(--color-fg)]" : "",
                          header.id !== "symbol" && "ml-auto",
                        )}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === "asc"  ? <ChevronUp   className="h-3 w-3" /> :
                         sorted === "desc" ? <ChevronDown className="h-3 w-3" /> :
                                            <ChevronsUpDown className="h-3 w-3 opacity-30" />}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>

        <tbody>
          <AnimatePresence mode="sync">
            {tableRows.map((row, i) => (
              <motion.tr
                key={row.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, delay: Math.min(i * 0.012, 0.24) }}
                className="border-b border-[var(--color-border)]/40 hover:bg-[var(--color-surface-hover)]/50 transition-colors"
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cn(
                      "p-2.5",
                      cell.column.id !== "symbol" && "text-right",
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </motion.tr>
            ))}
          </AnimatePresence>

          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={columns.length} className="p-8 text-center text-sm text-[var(--color-fg-muted)]">
                No stocks in this sector.
              </td>
            </tr>
          )}
          {rows.length === 0 && loading && (
            <tr>
              <td colSpan={columns.length} className="p-8 text-center text-sm text-[var(--color-fg-muted)]">
                Loading sector data…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
