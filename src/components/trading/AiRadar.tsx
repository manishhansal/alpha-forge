"use client";

import * as React from "react";
import {
  useTable,
  createColumnHelper,
  flexRender,
  coreFeatures,
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  createSortedRowModel,
  createFilteredRowModel,
  tableFeatures,
  filterFn_includesString,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  Search,
  LayoutGrid,
  List,
} from "lucide-react";
import { ConfidenceBar } from "@/components/trading/ConfidenceBar";
import { RegimeBadge, type RegimeLabel } from "@/components/trading/RegimeBadge";
import { SignalBadge, type AiAction } from "@/components/trading/SignalBadge";
import { useUIStore } from "@/store/uiStore";
import { SPRING_FAST } from "@/lib/motion-presets";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────

export interface AiRadarRow {
  rank: number;
  symbol: string;
  sector: string;
  aiScore: number; // 0–100
  momentum5d: number[]; // sparkline data points (5-10 values)
  relativeVolume: number; // e.g. 1.4 = 140% of average
  oiDelta: number; // positive = build-up, negative = unwind
  regime: RegimeLabel;
  signal: AiAction;
  entry?: number;
  stop?: number;
  tp1?: number;
  winProbability?: number;
  confluences?: Array<{ factor: string; value: string; positive: boolean }>;
}

export interface AiRadarProps {
  rows: AiRadarRow[];
  loading?: boolean;
  className?: string;
}

// ── Sparkline ─────────────────────────────────────────────────────────────

function Sparkline({ data }: { data: number[] }) {
  if (!data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const W = 60,
    H = 24,
    n = data.length;

  const points = data
    .map((v, i) => {
      const x = n === 1 ? W / 2 : (i / (n - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x},${y}`;
    })
    .join(" ");

  const isUp = data[data.length - 1] >= data[0];

  return (
    <svg width={W} height={H} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={
          isUp
            ? "var(--color-data-positive)"
            : "var(--color-data-negative)"
        }
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Relative Volume Bar ───────────────────────────────────────────────────

function RelVolBar({ value }: { value: number }) {
  // Clamp to a reasonable display range: 0–3× (300%)
  const clampedPct = Math.min((value / 3) * 100, 100);
  const isHigh = value >= 1.5;
  const isMed = value >= 1.0;

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="relative h-1.5 w-10 overflow-hidden rounded-full"
        style={{
          backgroundColor:
            "color-mix(in oklch, var(--color-data-neutral) 20%, transparent)",
        }}
      >
        {/* 1× reference line */}
        <div
          className="absolute top-0 bottom-0 w-px"
          style={{
            left: `${(1 / 3) * 100}%`,
            backgroundColor: "var(--color-fg-subtle)",
            opacity: 0.4,
          }}
        />
        <div
          className="h-full rounded-full"
          style={{
            width: `${clampedPct}%`,
            backgroundColor: isHigh
              ? "var(--color-data-negative)"
              : isMed
                ? "var(--color-data-positive)"
                : "var(--color-data-neutral)",
          }}
        />
      </div>
      <span
        className="text-[10px] tabular-nums"
        style={{
          color: "var(--color-fg-muted)",
          fontFamily: "var(--font-data)",
        }}
      >
        {value.toFixed(1)}×
      </span>
    </div>
  );
}

// ── OI Delta Cell ─────────────────────────────────────────────────────────

function OiDeltaCell({ value }: { value: number }) {
  const isUp = value > 0;
  const isNeutral = value === 0;
  const arrow = isNeutral ? "→" : isUp ? "↑" : "↓";
  const color = isNeutral
    ? "var(--color-fg-muted)"
    : isUp
      ? "var(--color-data-positive)"
      : "var(--color-data-negative)";

  return (
    <div className="flex items-center justify-end gap-1">
      <span
        className="text-xs font-semibold tabular-nums"
        style={{ color, fontFamily: "var(--font-data)" }}
      >
        {arrow}
      </span>
      <span
        className="text-[10px] tabular-nums"
        style={{ color: "var(--color-fg-muted)", fontFamily: "var(--font-data)" }}
      >
        {value > 0 ? "+" : ""}
        {(value * 100).toFixed(1)}%
      </span>
    </div>
  );
}

// ── Sort Icon ─────────────────────────────────────────────────────────────

const SortIcon = ({ sorted }: { sorted: false | "asc" | "desc" }) => {
  if (!sorted)
    return (
      <ChevronsUpDown className="h-3 w-3 text-[var(--color-fg-subtle)]" />
    );
  return sorted === "asc" ? (
    <ArrowUp className="h-3 w-3 text-[var(--color-ai-accent)]" />
  ) : (
    <ArrowDown className="h-3 w-3 text-[var(--color-ai-accent)]" />
  );
};

// ── Hover Detail Panel ────────────────────────────────────────────────────

function HoverDetailPanel({
  row,
  onClose,
  onViewSignal,
}: {
  row: AiRadarRow;
  onClose: () => void;
  onViewSignal: (symbol: string) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, x: 8 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.95, x: 8 }}
      transition={SPRING_FAST}
      className="absolute right-0 top-0 z-50 w-[280px] rounded-xl border border-[var(--color-panel-border)] bg-[var(--color-bg-elevated)] p-4 shadow-2xl"
    >
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-[var(--color-fg)]">
            {row.symbol}
          </span>
          {row.winProbability != null && (
            <span className="text-[10px] text-[var(--color-fg-muted)]">
              Win: {(row.winProbability * 100).toFixed(0)}%
            </span>
          )}
        </div>

        {/* Confluence factors */}
        {row.confluences && row.confluences.length > 0 && (
          <div className="space-y-1.5">
            {row.confluences.slice(0, 5).map((c) => (
              <div
                key={c.factor}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-[10px] text-[var(--color-fg-muted)] truncate">
                  {c.factor}
                </span>
                <span
                  className="text-[10px] font-medium tabular-nums"
                  style={{
                    color: c.positive
                      ? "var(--color-data-positive)"
                      : "var(--color-data-negative)",
                    fontFamily: "var(--font-data)",
                  }}
                >
                  {c.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Entry / Stop / TP1 */}
        {(row.entry != null || row.stop != null || row.tp1 != null) && (
          <div className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                { label: "Entry", value: row.entry },
                { label: "Stop", value: row.stop },
                { label: "TP1", value: row.tp1 },
              ] as Array<{ label: string; value: number | undefined }>
            )
              .filter((item) => item.value != null)
              .map(({ label, value }) => (
                <div
                  key={label}
                  className="rounded-lg p-1.5"
                  style={{ backgroundColor: "var(--color-surface)" }}
                >
                  <p
                    className="text-[8px] uppercase tracking-wider"
                    style={{ color: "var(--color-fg-subtle)" }}
                  >
                    {label}
                  </p>
                  <p
                    className="font-mono text-[11px] font-semibold"
                    style={{ color: "var(--color-fg)" }}
                  >
                    {value!.toFixed(1)}
                  </p>
                </div>
              ))}
          </div>
        )}

        {/* View Signal button */}
        <button
          type="button"
          onClick={() => {
            onViewSignal(row.symbol);
            onClose();
          }}
          className="w-full rounded-lg py-1.5 text-xs font-medium transition-colors"
          style={{
            backgroundColor:
              "color-mix(in oklch, var(--color-ai-accent) 12%, transparent)",
            color: "var(--color-ai-accent)",
            border:
              "1px solid color-mix(in oklch, var(--color-ai-accent) 28%, transparent)",
          }}
        >
          View Signal →
        </button>
      </div>
    </motion.div>
  );
}

// ── Loading Skeleton ──────────────────────────────────────────────────────

function LoadingSkeleton({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-3 py-2">
              <div
                className="animate-pulse rounded"
                style={{
                  height: "16px",
                  width: j === 0 ? "24px" : j === 1 ? "80px" : "60px",
                  backgroundColor:
                    "color-mix(in oklch, var(--color-fg-muted) 12%, transparent)",
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ── Table feature setup ───────────────────────────────────────────────────

const features = tableFeatures({
  ...coreFeatures,
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
});

type TFeatures = typeof features;

const columnHelper = createColumnHelper<TFeatures, AiRadarRow>();

// Column definitions — built once outside the component for stable references
const columns: ColumnDef<TFeatures, AiRadarRow>[] = [
  // 1. Rank
  columnHelper.accessor("rank", {
    id: "rank",
    header: "#",
    enableSorting: false,
    cell: (info) => (
      <span
        className="text-xs tabular-nums text-right block"
        style={{ color: "var(--color-fg-muted)", fontFamily: "var(--font-data)" }}
      >
        {info.getValue() as number}
      </span>
    ),
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 2. Stock
  columnHelper.accessor("symbol", {
    id: "stock",
    header: "Stock",
    enableSorting: true,
    cell: (info) => {
      const row = info.row.original;
      return (
        <div className="min-w-0">
          <p
            className="font-bold text-xs"
            style={{ color: "var(--color-fg)" }}
          >
            {row.symbol}
          </p>
          <p
            className="text-[10px] truncate"
            style={{ color: "var(--color-fg-muted)" }}
          >
            {row.sector}
          </p>
        </div>
      );
    },
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 3. AI Score
  columnHelper.accessor("aiScore", {
    id: "aiScore",
    header: "AI Score",
    enableSorting: true,
    cell: (info) => (
      <div className="w-[72px]">
        <ConfidenceBar
          value={info.getValue() as number}
          showLabel
          height={6}
        />
      </div>
    ),
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 4. Momentum (sparkline, not sortable)
  columnHelper.accessor("momentum5d", {
    id: "momentum",
    header: "5D Momentum",
    enableSorting: false,
    cell: (info) => (
      <Sparkline data={info.getValue() as number[]} />
    ),
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 5. Relative Volume
  columnHelper.accessor("relativeVolume", {
    id: "volume",
    header: "Volume",
    enableSorting: true,
    cell: (info) => <RelVolBar value={info.getValue() as number} />,
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 6. OI Delta
  columnHelper.accessor("oiDelta", {
    id: "oi",
    header: "OI Build-up",
    enableSorting: true,
    cell: (info) => <OiDeltaCell value={info.getValue() as number} />,
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 7. Regime
  columnHelper.accessor("regime", {
    id: "regime",
    header: "Regime",
    enableSorting: true,
    cell: (info) => (
      <RegimeBadge
        regime={info.getValue() as RegimeLabel}
        animate={false}
      />
    ),
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,

  // 8. Signal
  columnHelper.accessor("signal", {
    id: "signal",
    header: "Signal",
    enableSorting: true,
    cell: (info) => (
      <SignalBadge action={info.getValue() as AiAction} size="sm" />
    ),
  }) as unknown as ColumnDef<TFeatures, AiRadarRow>,
];

// ── Main AiRadar component ────────────────────────────────────────────────

export function AiRadar({ rows, loading = false, className }: AiRadarProps) {
  const tableDensity = useUIStore((s) => s.tableDensity);
  const setDensity = useUIStore((s) => s.setDensity);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState<string>("");
  const [hoveredRowId, setHoveredRowId] = React.useState<string | null>(null);
  const hoverTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Handle view signal — placeholder, consumers can override via prop if needed
  const handleViewSignal = React.useCallback((symbol: string) => {
    // No-op default — consumers should integrate with router/modal
    console.debug("[AiRadar] view signal:", symbol);
  }, []);

  // Hover handlers with 200ms delay
  const handleRowMouseEnter = React.useCallback((rowId: string) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredRowId(rowId);
    }, 200);
  }, []);

  const handleRowMouseLeave = React.useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = null;
    setHoveredRowId(null);
  }, []);

  // Clean up timeout on unmount
  React.useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const table = useTable(
    {
      features,
      columns,
      data: rows,
      state: {
        sorting,
        globalFilter,
      },
      onSortingChange: setSorting,
      onGlobalFilterChange: setGlobalFilter,
      getRowId: (row) => `${row.rank}-${row.symbol}`,
      globalFilterFn: filterFn_includesString,
    },
    (state) => ({
      sorting: state.sorting,
      globalFilter: state.globalFilter,
    }),
  );

  const headerGroups = table.getHeaderGroups();
  // In TanStack Table v9, sorted row model already incorporates filtered rows
  const tableRows = sorting.length
    ? table.getSortedRowModel().rows
    : table.getFilteredRowModel().rows;

  // Density cycle: compact → default → comfortable
  const cycleDensity = React.useCallback(() => {
    const next: Record<
      "compact" | "default" | "comfortable",
      "compact" | "default" | "comfortable"
    > = {
      compact: "default",
      default: "comfortable",
      comfortable: "compact",
    };
    setDensity(next[tableDensity]);
  }, [tableDensity, setDensity]);

  const DENSITY_LABEL = {
    compact: "Compact",
    default: "Default",
    comfortable: "Comfortable",
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none"
            style={{ color: "var(--color-fg-muted)" }}
            aria-hidden
          />
          <input
            type="search"
            placeholder="Filter symbol or sector…"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-lg py-1.5 pl-8 pr-3 text-xs outline-none transition-colors focus:ring-1"
            style={{
              backgroundColor:
                "color-mix(in oklch, var(--color-fg-muted) 8%, transparent)",
              border: "1px solid var(--color-panel-border)",
              color: "var(--color-fg)",
              "--tw-ring-color": "var(--color-ai-accent)",
            } as React.CSSProperties}
            aria-label="Search symbols and sectors"
          />
        </div>

        {/* Density toggle */}
        <button
          type="button"
          onClick={cycleDensity}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition-colors"
          style={{
            backgroundColor:
              "color-mix(in oklch, var(--color-fg-muted) 8%, transparent)",
            border: "1px solid var(--color-panel-border)",
            color: "var(--color-fg-muted)",
          }}
          aria-label={`Table density: ${tableDensity}. Click to cycle.`}
          title={`Density: ${DENSITY_LABEL[tableDensity]}`}
        >
          {tableDensity === "comfortable" ? (
            <LayoutGrid className="h-3 w-3" aria-hidden />
          ) : (
            <List className="h-3 w-3" aria-hidden />
          )}
          <span className="hidden sm:inline">{DENSITY_LABEL[tableDensity]}</span>
        </button>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-panel-border)]">
        <table
          className="w-full text-sm"
          data-density={tableDensity}
          aria-label="AI Stock Radar"
        >
          <thead
            className="sticky top-0 z-10 border-b border-[var(--color-panel-border)]"
            style={{ backgroundColor: "var(--color-bg-elevated)" }}
          >
            {headerGroups.map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const isRankCol = header.id === "rank";

                  return (
                    <th
                      key={header.id}
                      className={cn(
                        "px-3 py-2 text-[10px] font-semibold uppercase tracking-wide select-none whitespace-nowrap",
                        isRankCol ? "text-right w-8" : "text-left",
                        header.id === "oi" || header.id === "volume"
                          ? "text-right"
                          : "",
                      )}
                      style={{ color: "var(--color-fg-muted)" }}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-fg)]"
                          style={{
                            color: sorted
                              ? "var(--color-fg)"
                              : "var(--color-fg-muted)",
                          }}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          <SortIcon sorted={sorted} />
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {loading ? (
              <LoadingSkeleton cols={columns.length} />
            ) : tableRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-xs"
                  style={{ color: "var(--color-fg-muted)" }}
                >
                  {globalFilter
                    ? `No stocks match "${globalFilter}"`
                    : "No data available"}
                </td>
              </tr>
            ) : (
              <AnimatePresence mode="sync">
                {tableRows.map((row, i) => {
                  const isHovered = hoveredRowId === row.id;
                  return (
                    <motion.tr
                      key={row.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: 0.22,
                        delay: Math.min(i * 0.018, 0.3),
                      }}
                      className="relative border-b border-[var(--color-panel-border)]/40 transition-colors"
                      style={{
                        backgroundColor: isHovered
                          ? "color-mix(in oklch, var(--color-ai-accent) 5%, transparent)"
                          : "transparent",
                      }}
                      tabIndex={0}
                      onMouseEnter={() => handleRowMouseEnter(row.id)}
                      onMouseLeave={handleRowMouseLeave}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          setHoveredRowId((prev) =>
                            prev === row.id ? null : row.id,
                          );
                        }
                        if (e.key === "Escape") {
                          setHoveredRowId(null);
                        }
                      }}
                      aria-label={`${row.original.symbol} — ${row.original.sector}`}
                    >
                      {row.getAllCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={cn(
                            "px-3 py-2",
                            cell.column.id === "rank" ? "text-right" : "",
                            cell.column.id === "oi" ||
                              cell.column.id === "volume"
                              ? "text-right"
                              : "",
                          )}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      ))}

                      {/* Hover Detail Panel */}
                      <AnimatePresence>
                        {isHovered && (
                          <td
                            // Render the panel in an absolute overlay, not a real cell
                            style={{ padding: 0, border: "none" }}
                            aria-hidden
                          >
                            <HoverDetailPanel
                              row={row.original}
                              onClose={() => setHoveredRowId(null)}
                              onViewSignal={handleViewSignal}
                            />
                          </td>
                        )}
                      </AnimatePresence>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            )}
          </tbody>
        </table>
      </div>

      {/* Row count */}
      {!loading && rows.length > 0 && (
        <p
          className="text-[10px] tabular-nums"
          style={{ color: "var(--color-fg-subtle)" }}
        >
          {tableRows.length} of {rows.length} stocks
        </p>
      )}
    </div>
  );
}
