"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Expand,
  Flame,
  Layers,
  PlusCircle,
  RefreshCw,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/india/ui/button";
import {
  FilterTabs,
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import {
  SignalTableHead,
  SignalTableRow,
  kindClass,
} from "@/components/india/ui/signal-table-row";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { dataSourceLabels } from "@/features/settings/data-sources-shared";
import { MarketCoreWidget } from "@/components/3d/market-core-widget";
import { notify } from "@/lib/toast";
import { SectorStocksTable } from "@/components/india/options/sector-stocks-table";
import type { StockRow as SectorStockRow } from "@/components/india/options/sector-stocks-table";
import { fmtTime } from "@/lib/utils";

type IndexQuote = {
  name: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  prevClose: number | null;
};

type StockRow = {
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
  /** Server-tracked: when the current signal was first observed (Unix ms).
   *  Authoritative — survives across page reloads and tab-closed gaps. */
  signalSince?: number | null;
};

type SectorStocksResponse = {
  sector: string;
  rows: StockRow[];
  fetchedAt?: string;
};

type SortKey =
  | "symbol"
  | "price"
  | "changePct"
  | "fromSma50Pct"
  | "upsidePct"
  | "downsidePct"
  | "score"
  | "signal"
  | "heldFor";
type SortDir = "asc" | "desc";

type SignalState = { signal: string; since: number };
type SignalAgeMap = Record<string, SignalState>;

type MsbSignalRow = {
  Symbol: string;
  Side: string;
  Entry: number | string;
  SL_ATR: number | string;
  TGT_ATR: number | string;
  Strike: number | string;
  Type: string;
  Strength: number | string;
};

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  symbol: "asc",
  price: "desc",
  changePct: "desc",
  fromSma50Pct: "desc",
  upsidePct: "desc",
  downsidePct: "desc",
  score: "desc",
  signal: "desc",
  heldFor: "desc",
};

// IST = UTC+5:30. Day-key for the local trading session (resets at midnight IST).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDayKey(now: number = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const SIGNAL_AGE_KEY_PREFIX = "india-msb:signalAge";

function loadSignalAges(): SignalAgeMap {
  if (typeof window === "undefined") return {};
  const today = istDayKey();
  const key = `${SIGNAL_AGE_KEY_PREFIX}:${today}`;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    return JSON.parse(raw) as SignalAgeMap;
  } catch {
    return {};
  }
}

function saveSignalAges(map: SignalAgeMap): void {
  if (typeof window === "undefined") return;
  const today = istDayKey();
  const currentKey = `${SIGNAL_AGE_KEY_PREFIX}:${today}`;
  try {
    window.localStorage.setItem(currentKey, JSON.stringify(map));
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(`${SIGNAL_AGE_KEY_PREFIX}:`) && k !== currentKey) {
        window.localStorage.removeItem(k);
      }
    }
  } catch {
    /* quota exceeded / private mode — silently ignore */
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

const SIGNAL_RANK: Record<Exclude<StockRow["signal"], "N/A">, number> = {
  "STRONG SELL": 0,
  SELL: 1,
  HOLD: 2,
  BUY: 3,
  "STRONG BUY": 4,
};

function getSortVal(
  r: StockRow,
  key: SortKey,
  ageMs?: number | null,
): number | string | null {
  if (key === "symbol") return r.symbol;
  if (key === "signal") {
    return r.signal === "N/A" ? null : SIGNAL_RANK[r.signal];
  }
  if (key === "heldFor") {
    return typeof ageMs === "number" ? ageMs : null;
  }
  const v = r[key as keyof StockRow];
  return typeof v === "number" ? v : null;
}

const fmt = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d);

const isVix = (name: string) => name.toUpperCase().includes("VIX");

export default function MsbDashboard() {
  const [data, setData] = useState<MsbSignalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [nifty, setNifty] = useState<{ bias: string; price: string }>({
    bias: "-",
    price: "-",
  });
  const snapshot = useIndiaMarketStore((s) => s.snapshot) ?? {
    indices: [],
    sectors: [],
    fetchedAt: undefined,
  };
  const setSnapshot = useIndiaMarketStore((s) => s.setSnapshot);
  const snapshotSources = useIndiaMarketStore((s) => s.snapshot?.sources) ?? [];
  const sourceBadge =
    snapshotSources.length > 0 ? dataSourceLabels(snapshotSources).join(" + ") : null;
  const [selectedSector, setSelectedSector] = useState<string | null>(null);

  // In-flight tracking + a stable AbortController per mount keep us under
  // the browser's 6-socket-per-origin cap.
  const inFlightRef = useRef(false);
  const ctrlRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    try {
      setLoading(true);
      const init = { cache: "no-store" as const, signal: ctrl.signal };
      const [signalsRes, biasRes, snapRes] = await Promise.all([
        fetch("/api/in/msb-signals", init),
        fetch("/api/in/nifty-bias", init),
        fetch("/api/in/market-snapshot", init),
      ]);
      const [signalsJson, biasJson, snapJson] = await Promise.all([
        signalsRes.json(),
        biasRes.json(),
        snapRes.json(),
      ]);
      if (ctrl.signal.aborted) return;
      const incoming: MsbSignalRow[] = Array.isArray(signalsJson) ? signalsJson : [];
      setData(incoming);
      // Toast when new strong signals appear (compare against previous data)
      setData((prev) => {
        const prevSymbols = new Set(prev.map((r) => r.Symbol));
        const fresh = incoming.filter((r) => !prevSymbols.has(r.Symbol));
        for (const row of fresh.slice(0, 3)) {
          notify.signal(
            String(row.Symbol),
            row.Side?.toUpperCase() === "BUY" ? "BUY" : "SELL",
            Number(row.Strength) || undefined,
          );
        }
        return incoming;
      });
      setNifty(biasJson);
      setSnapshot(snapJson);
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name !== "AbortError") console.error(err);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [setSnapshot]);

  useEffect(() => {
    // Defer the initial fetch onto the next task so the eslint
    // `react-hooks/set-state-in-effect` rule sees state updates only via an
    // external-system callback (the timer), not a synchronous effect body.
    const initial = setTimeout(() => void fetchData(), 0);
    const t = setInterval(fetchData, 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
      ctrlRef.current?.abort();
    };
  }, [fetchData]);

  const addJournal = (row: MsbSignalRow) => {
    try {
      const existing = JSON.parse(
        localStorage.getItem("india-journal") || "[]",
      );
      existing.push({ ...row, time: new Date().toISOString() });
      localStorage.setItem("india-journal", JSON.stringify(existing));
    } catch {
      /* ignore quota / private-mode failures */
    }
  };

  const sortedSectors = useMemo(() => {
    return [...snapshot.sectors].sort((a, b) => {
      if (a.changePct == null && b.changePct == null) return 0;
      if (a.changePct == null) return 1;
      if (b.changePct == null) return -1;
      return b.changePct - a.changePct;
    });
  }, [snapshot.sectors]);

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* ── Hero header ──────────────────────────────────────────────────── */}
      <section>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mb-5 flex items-end justify-between gap-3"
        >
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--color-fg)]">
                Market Pulse
              </h1>
              {sourceBadge && (
                <span
                  className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]"
                  title="Live data source(s) actually serving this snapshot"
                >
                  {sourceBadge}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs sm:text-sm text-[var(--color-fg-subtle)]">
              Live snapshot · Indian indices &amp; sectoral momentum
            </p>
          </div>
          <Button
            onClick={fetchData}
            disabled={loading}
            size="sm"
            variant="outline"
            className="rounded-xl border-[var(--color-border-strong)] hover:border-[var(--color-brand)] hover:text-[var(--color-brand)] transition-all"
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </motion.div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 sm:gap-4 perspective-1000 items-stretch">
          {/* Market Intelligence Core — compact 3D regime card, same height as index cards */}
          <div className="col-span-1 row-span-1 min-h-[180px]">
            <MarketCoreWidget niftyBias={nifty.bias} height={120} />
          </div>

          <AnimatePresence>
            {snapshot.indices.map((idx, i) => (
              <IndexCard
                key={idx.symbol}
                idx={idx}
                delay={i * 0.07}
                niftyBias={idx.name === "NIFTY 50" ? nifty.bias : null}
              />
            ))}
          </AnimatePresence>
          {snapshot.indices.length === 0 && (
            <div className="col-span-full text-sm text-muted-foreground px-1">
              Loading market data…
            </div>
          )}
        </div>
      </section>

      {/* Sectoral Heatmap */}
      <section>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
          className="glass rounded-2xl p-4 sm:p-5 shadow-sm"
        >
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-400/25 to-rose-500/20 ring-1 ring-amber-400/20">
                <Flame className="h-4 w-4 text-amber-400" />
              </div>
              <h2 className="text-base sm:text-lg font-semibold tracking-tight">
                NIFTY Sectoral Heatmap
              </h2>
            </div>
            <span className="text-[10px] sm:text-xs text-[var(--color-fg-subtle)]">
              {snapshot.fetchedAt
                ? `Updated ${fmtTime(snapshot.fetchedAt)}`
                : "—"}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5 perspective-1000">
            <AnimatePresence>
              {sortedSectors.map((s, i) => (
                <SectorTile
                  key={s.symbol}
                  sector={s}
                  delay={i * 0.04}
                  onClick={() => setSelectedSector(s.name)}
                />
              ))}
            </AnimatePresence>
            {sortedSectors.length === 0 && (
              <div className="col-span-full text-sm text-muted-foreground">
                Loading sectoral data…
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3 text-[10px] sm:text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-6 rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600" />
              Bullish
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-6 rounded-full bg-gradient-to-r from-rose-600 to-rose-400" />
              Bearish
            </span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">
              Click any sector to drill into its F&amp;O stocks
            </span>
          </div>
        </motion.div>
      </section>

      {/* Signals Table */}
      <MsbSignalsSection data={data} loading={loading} addJournal={addJournal} />

      <SectorStocksModal
        sector={selectedSector}
        onClose={() => setSelectedSector(null)}
      />
    </div>
  );
}

function IndexCard({
  idx,
  delay,
  niftyBias,
}: {
  idx: IndexQuote;
  delay: number;
  niftyBias: string | null;
}) {
  const pct      = idx.changePct ?? 0;
  const up       = pct >= 0;
  const inverted = isVix(idx.name);
  const positive = inverted ? !up : up;

  const tone = positive ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]";

  // Richer gradient: bull = emerald→cyan, bear = rose→orange
  const accentGrad = positive
    ? "from-[color-mix(in_oklch,var(--bull)_22%,transparent)] via-[color-mix(in_oklch,var(--info)_8%,transparent)] to-transparent"
    : "from-[color-mix(in_oklch,var(--bear)_22%,transparent)] via-[color-mix(in_oklch,var(--warning)_6%,transparent)] to-transparent";

  // Neon glow for top border
  const borderGlow = positive
    ? "shadow-[inset_0_1px_0_0_color-mix(in_oklch,var(--bull)_30%,transparent)]"
    : "shadow-[inset_0_1px_0_0_color-mix(in_oklch,var(--bear)_30%,transparent)]";

  // 3D tilt
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-50, 50], [7, -7]), { stiffness: 220, damping: 20 });
  const rotateY = useSpring(useTransform(mx, [-50, 50], [-7, 7]), { stiffness: 220, damping: 20 });

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mx.set(e.clientX - rect.left - rect.width  / 2);
    my.set(e.clientY - rect.top  - rect.height / 2);
  };
  const onMouseLeave = () => { mx.set(0); my.set(0); };

  const chartHref = `/in/chart/${encodeURIComponent(idx.symbol)}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 22, scale: 0.96 }}
      animate={{ opacity: 1, y: 0,  scale: 1    }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ duration: 0.38, delay, ease: [0.22, 1, 0.36, 1] }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
      className={`relative rounded-2xl overflow-hidden bento-card holo-card ${borderGlow}`}
    >
      {/* Gradient wash */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-br ${accentGrad} pointer-events-none`}
      />

      {/* Card body lifted in Z */}
      <Link
        href={chartHref}
        className="relative block p-4 sm:p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] rounded-2xl"
        style={{ transform: "translateZ(18px)" }}
      >
        {/* Label + bias badge */}
        <div className="flex items-center justify-between gap-1.5 mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-fg-subtle)] truncate">
            {idx.name}
          </span>
          {niftyBias && niftyBias !== "-" && (
            <span
              className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider ${
                niftyBias === "BULLISH"
                  ? "bg-[color-mix(in_oklch,var(--bull)_18%,transparent)] text-[var(--color-bull)]"
                  : niftyBias === "BEARISH"
                    ? "bg-[color-mix(in_oklch,var(--bear)_18%,transparent)] text-[var(--color-bear)]"
                    : "bg-[var(--color-surface)] text-[var(--color-fg-muted)]"
              }`}
            >
              {niftyBias}
            </span>
          )}
        </div>

        {/* Price */}
        <div className="text-xl sm:text-2xl font-bold tabular tracking-tight text-[var(--color-fg)] num">
          {fmt(idx.price)}
        </div>

        {/* Change row */}
        <div className={`mt-1.5 flex items-center gap-1 text-[11px] sm:text-xs font-semibold ${tone}`}>
          {positive
            ? <ArrowUpRight   className="h-3.5 w-3.5 shrink-0" />
            : <ArrowDownRight className="h-3.5 w-3.5 shrink-0" />}
          <span className="num">
            {positive ? "+" : ""}{fmt(idx.change)} ({positive ? "+" : ""}{fmt(idx.changePct)}%)
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

function SectorTile({
  sector,
  delay,
  onClick,
}: {
  sector: IndexQuote;
  delay: number;
  onClick: () => void;
}) {
  const pct       = sector.changePct ?? 0;
  const up        = pct >= 0;
  const intensity = Math.min(Math.abs(pct) / 3, 1);
  const alpha     = 0.15 + intensity * 0.70;

  // Bull: emerald, Bear: rose — richer saturation than before
  const bg = up
    ? `oklch(0.64 0.20 152 / ${alpha})`
    : `oklch(0.60 0.24 22  / ${alpha})`;

  const textTone =
    intensity > 0.45
      ? "text-white"
      : up
        ? "text-emerald-800 dark:text-emerald-200"
        : "text-rose-800 dark:text-rose-200";

  const glowColor = up
    ? `oklch(0.64 0.20 152 / ${intensity * 0.35})`
    : `oklch(0.60 0.24 22  / ${intensity * 0.35})`;

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 10, scale: 0.94 }}
      animate={{ opacity: 1, y: 0,  scale: 1    }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ scale: 1.07, rotateX: -4, rotateY: 3, z: 28 }}
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      style={{
        backgroundColor: bg,
        transformStyle: "preserve-3d",
        boxShadow: `0 4px 24px -8px ${glowColor}, inset 0 1px 0 rgba(255,255,255,0.08)`,
      }}
      className={`rounded-xl p-3 text-left cursor-pointer border border-white/8 transition-shadow focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] ${textTone}`}
      title={`${sector.symbol} — click for F&O stocks`}
    >
      <div className="text-[11px] font-semibold truncate leading-tight">{sector.name}</div>
      <div className="mt-1 text-sm font-bold tabular">
        {up ? "+" : ""}{fmt(pct)}%
      </div>
      <div className="text-[10px] opacity-75 tabular mt-0.5">{fmt(sector.price)}</div>
    </motion.button>
  );
}

function SideBadge({ side }: { side?: string }) {
  if (!side) return null;
  const buy = side.toUpperCase() === "BUY";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
        buy
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-rose-500/15 text-rose-700 dark:text-rose-400"
      }`}
    >
      {buy ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {side}
    </span>
  );
}

// Hoisted out of `SectorStocksModal` so React 19 doesn't re-create the
// component identity on every render (which would also blow away child
// state). Receives the active sort state as plain props.
function SortHeader({
  label,
  k,
  align = "left",
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  k: SortKey;
  align?: "left" | "right";
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th
      className={`p-2.5 select-none font-medium text-xs uppercase tracking-wide ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 transition-colors cursor-pointer hover:text-foreground ${
          active ? "text-foreground font-semibold" : "text-muted-foreground"
        }`}
      >
        <span>{label}</span>
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronDown className="h-3 w-3 opacity-25" />
        )}
      </button>
    </th>
  );
}

function MsbSignalsSection({
  data,
  loading,
  addJournal,
}: {
  data: MsbSignalRow[];
  loading: boolean;
  addJournal: (row: MsbSignalRow) => void;
}) {
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const getConfidence = useCallback(
    (row: MsbSignalRow) => Number(row.Strength) || 0,
    [],
  );
  const getWinrate = useCallback(
    (row: MsbSignalRow) => {
      const s = Number(row.Strength) || 0;
      return Math.min(s / 1.5, 1);
    },
    [],
  );

  const {
    pageItems,
    activeTab,
    setActiveTab,
    page,
    setPage,
    totalPages,
    filteredTotal,
    pageSize,
    tabs,
  } = usePaginationFilter({
    items: data,
    pageSize: 5,
    getConfidence,
    getWinrate,
    confidenceThreshold: 0.7,
    winrateThreshold: 0.6,
  });

  // Convert MsbSignalRow to the generic SignalRow shape for SignalTableRow.
  // We surface Entry/SL/Target/Strike/Strength in the detail panel via `note`.
  const toSignalRow = useCallback(
    (row: MsbSignalRow) => ({
      symbol: String(row.Symbol),
      price: typeof row.Entry === "number" ? row.Entry : null,
      changePct: null,
      metric: Number(row.Strength) || 0,
      metricLabel: `Str ${Number(row.Strength).toFixed(2)}`,
      kind: row.Side?.toUpperCase() === "BUY" ? "BULLISH" : "BEARISH",
      note:
        `Entry ${row.Entry} · SL ${row.SL_ATR} · Tgt ${row.TGT_ATR} · ` +
        `Strike ${row.Strike} · ${row.Type}`,
    }),
    [],
  );

  // col count: chevron + Symbol + Price(Entry) + Chg% + Side + Strength + Journal = 7
  const COL_SPAN = 7;

  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.2 }}
        className="glass rounded-2xl p-4 sm:p-5 shadow-sm"
      >
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-blue-400/25 to-violet-500/20 ring-1 ring-blue-400/20">
              <Sparkles className="h-4 w-4 text-blue-400" />
            </div>
            <h2 className="text-base sm:text-lg font-semibold tracking-tight">
              MSB–OB Intraday Signals
            </h2>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <FilterTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
            <span className="text-[10px] sm:text-xs text-muted-foreground">
              {filteredTotal} of {data.length} setup{data.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-sm">
            <thead>
              <SignalTableHead
                extraTrailHeaders={
                  <>
                    <th className="p-2.5 font-medium">Side</th>
                    <th className="p-2.5 text-right font-medium">Strength</th>
                    <th className="p-2.5" />
                  </>
                }
              />
            </thead>
            <tbody>
              <AnimatePresence>
                {pageItems.map((row, i) => (
                  <SignalTableRow
                    key={`${row.Symbol}-${(page - 1) * pageSize + i}`}
                    hit={toSignalRow(row)}
                    colSpan={COL_SPAN}
                    index={i}
                    expanded={expandedSymbol === row.Symbol}
                    onToggle={() =>
                      setExpandedSymbol((prev) =>
                        prev === row.Symbol ? null : row.Symbol,
                      )
                    }
                    extraTrailCells={
                      <>
                        <td className="p-2.5">
                          <SideBadge side={row.Side} />
                        </td>
                        <td className="p-2.5 text-right tabular font-semibold">
                          {Number(row.Strength).toFixed(2)}
                        </td>
                        <td className="p-2.5">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              addJournal(row);
                            }}
                            title="Add to journal"
                          >
                            <PlusCircle className="h-3 w-3 mr-1" />
                            Journal
                          </Button>
                        </td>
                      </>
                    }
                  />
                ))}
              </AnimatePresence>

              {data.length === 0 && !loading && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-muted-foreground text-sm">
                    No setups available — run the Python scanner during market hours.
                  </td>
                </tr>
              )}
              {data.length > 0 && pageItems.length === 0 && !loading && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-muted-foreground text-sm">
                    No setups match the current filter.
                  </td>
                </tr>
              )}
              {loading && data.length === 0 && (
                <tr>
                  <td colSpan={COL_SPAN} className="p-8 text-center text-muted-foreground text-sm">
                    Loading signals…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <PaginationStrip
          page={page}
          totalPages={totalPages}
          filteredTotal={filteredTotal}
          pageSize={pageSize}
          disabled={loading}
          onPrev={() => setPage(page - 1)}
          onNext={() => setPage(page + 1)}
          onJump={setPage}
        />
      </motion.div>
    </section>
  );
}

function SectorStocksModal({
  sector,
  onClose,
}: {
  sector: string | null;
  onClose: () => void;
}) {
  const [resp, setResp] = useState<SectorStocksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("changePct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [signalAges, setSignalAges] = useState<SignalAgeMap>(() =>
    loadSignalAges(),
  );

  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!sector) return;
    const t = setInterval(() => setNowTs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [sector]);

  useEffect(() => {
    if (!sector) {
      // Defer to the next task — clearing state synchronously here would
      // trip the React 19 `react-hooks/set-state-in-effect` lint.
      const id = setTimeout(() => setResp(null), 0);
      return () => clearTimeout(id);
    }
    let cancelled = false;
    let inFlight = false;
    let ctrl: AbortController | null = null;

    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      ctrl = new AbortController();
      try {
        setLoading(true);
        const r = await fetch(
          `/api/in/sector-stocks?sector=${encodeURIComponent(sector)}`,
          { cache: "no-store", signal: ctrl.signal },
        );
        const json = (await r.json()) as SectorStocksResponse;
        if (cancelled) return;
        setResp(json);

        const observed = Date.now();
        setSignalAges((prev) => {
          const next: SignalAgeMap = { ...prev };
          let changed = false;
          for (const row of json.rows ?? []) {
            const sig = row.signal;
            if (sig === "N/A") continue;
            const existing = next[row.symbol];
            if (!existing || existing.signal !== sig) {
              next[row.symbol] = { signal: sig, since: observed };
              changed = true;
            }
          }
          if (changed) saveSignalAges(next);
          return changed ? next : prev;
        });
      } catch (e: unknown) {
        const err = e as { name?: string };
        if (err?.name !== "AbortError") console.error(e);
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    const initial = setTimeout(() => void load(), 0);
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(t);
      ctrl?.abort();
    };
  }, [sector]);

  useEffect(() => {
    if (!sector) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sector, onClose]);

  // Memoize the rows array so the `sortedRows` `useMemo` below has a stable
  // dependency reference (rather than `resp?.rows ?? []` which constructs a
  // fresh array literal on every render and would invalidate the cache).
  const rows = useMemo<StockRow[]>(() => resp?.rows ?? [], [resp]);

  const ageFor = useCallback(
    (row: StockRow): { ms: number; source: "server" | "local" } | null => {
      if (row.signal !== "STRONG BUY" && row.signal !== "STRONG SELL")
        return null;
      if (typeof row.signalSince === "number") {
        return { ms: Math.max(0, nowTs - row.signalSince), source: "server" };
      }
      const entry = signalAges[row.symbol];
      if (!entry || entry.signal !== row.signal) return null;
      return { ms: Math.max(0, nowTs - entry.since), source: "local" };
    },
    [signalAges, nowTs],
  );

  const sortedRows = useMemo(() => {
    const arr = [...rows];
    const dirMul = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      const va = getSortVal(a, sortKey, ageFor(a)?.ms ?? null);
      const vb = getSortVal(b, sortKey, ageFor(b)?.ms ?? null);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dirMul;
      }
      return ((va as number) - (vb as number)) * dirMul;
    });
    return arr;
  }, [rows, sortKey, sortDir, ageFor]);

  const getSectorConfidence = useCallback(
    (row: StockRow) => {
      // Score is −100…+100. Normalize to 0–1 for the filter.
      return (row.score + 100) / 200;
    },
    [],
  );

  const getSectorWinrate = useCallback(
    (row: StockRow) => {
      // Use upside % as winrate proxy — higher upside = better potential.
      const up = row.upsidePct ?? 0;
      return Math.min(Math.abs(up) / 30, 1); // cap at 30% upside → 1.0
    },
    [],
  );

  const {
    pageItems: paginatedRows,
    activeTab: sectorFilterTab,
    setActiveTab: setSectorFilterTab,
    page: sectorPage,
    setPage: setSectorPage,
    totalPages: sectorTotalPages,
    filteredTotal: sectorFilteredTotal,
    pageSize: sectorPageSize,
    tabs: sectorTabs,
  } = usePaginationFilter({
    items: sortedRows,
    pageSize: 5,
    getConfidence: getSectorConfidence,
    getWinrate: getSectorWinrate,
    confidenceThreshold: 0.7,
    winrateThreshold: 0.6,
  });

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const sortLabel: Record<SortKey, string> = {
    symbol: "Symbol",
    price: "Price",
    changePct: "Day %",
    fromSma50Pct: "vs SMA50",
    upsidePct: "Upside",
    downsidePct: "Downside",
    score: "Score",
    signal: "Signal",
    heldFor: "Held for",
  };

  const signalClass = (sig: StockRow["signal"]) => {
    switch (sig) {
      case "STRONG BUY":
        return "bg-emerald-600 text-white shadow-emerald-600/30 shadow-md";
      case "BUY":
        return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
      case "HOLD":
        return "bg-muted text-muted-foreground";
      case "SELL":
        return "bg-rose-500/15 text-rose-700 dark:text-rose-400";
      case "STRONG SELL":
        return "bg-rose-600 text-white shadow-rose-600/30 shadow-md";
      default:
        return "bg-muted/50 text-muted-foreground/60";
    }
  };

  const pctCell = (n: number | null | undefined) => {
    if (n == null || Number.isNaN(n))
      return <span className="opacity-40">—</span>;
    const up = n >= 0;
    return (
      <span
        className={
          up ? "text-emerald-500 font-medium" : "text-rose-500 font-medium"
        }
      >
        {up ? "+" : ""}
        {n.toFixed(2)}%
      </span>
    );
  };

  return (
    <AnimatePresence>
      {sector && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md flex items-center justify-center p-3 sm:p-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            className="glass-strong rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[var(--color-border)] bg-gradient-to-br from-[var(--color-bg-elevated)] to-[var(--color-surface)]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-violet-500/15 ring-1 ring-blue-500/20 shrink-0">
                  <Layers className="h-4 w-4 text-blue-400" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold truncate">
                    {sector} — F&amp;O Stocks
                  </h2>
                  <div className="text-[10px] sm:text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>
                      Sorted by {sortLabel[sortKey]}{" "}
                      {sortDir === "asc" ? "↑" : "↓"}
                    </span>
                    <span>·</span>
                    <span>{sectorFilteredTotal} of {rows.length} stocks</span>
                    {resp?.fetchedAt && (
                      <>
                        <span>·</span>
                        <span>
                          updated{" "}
                          {fmtTime(resp.fetchedAt)}
                        </span>
                      </>
                    )}
                    {loading && (
                      <span className="flex items-center gap-1 text-blue-500">
                        <Activity className="h-2.5 w-2.5 animate-pulse" />
                        refreshing
                      </span>
                    )}
                  </div>
                  <FilterTabs
                    tabs={sectorTabs}
                    active={sectorFilterTab}
                    onChange={setSectorFilterTab}
                    className="mt-1.5"
                  />
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-full"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* ── TanStack Table replaces hand-rolled table ─── */}
            <div className="overflow-auto flex-1">
              <SectorStocksTable
                rows={sortedRows.map((r) => {
                  const age = ageFor(r);
                  return {
                    ...r,
                    ageMs:     age?.ms     ?? null,
                    ageSource: age?.source ?? null,
                  } as SectorStockRow;
                })}
                loading={loading}
              />
            </div>

            <div className="px-4 sm:px-5 py-2 border-t border-[var(--color-border)]">
              <PaginationStrip
                page={sectorPage}
                totalPages={sectorTotalPages}
                filteredTotal={sectorFilteredTotal}
                pageSize={sectorPageSize}
                disabled={loading}
                onPrev={() => setSectorPage(sectorPage - 1)}
                onNext={() => setSectorPage(sectorPage + 1)}
                onJump={setSectorPage}
              />
            </div>

            <div className="p-3 sm:p-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[10px] sm:text-[11px] text-[var(--color-fg-subtle)] flex flex-wrap gap-x-4 gap-y-1">
              <span>
                <b>Upside</b>: % to max(52w-high, analyst target).
              </span>
              <span>
                <b>Downside</b>: % to 52-week low.
              </span>
              <span>
                <b>Score</b>: −100…+100 from price vs SMA50/SMA200, day move,
                analyst target.
              </span>
              <span>
                <b>Held for</b>: server-tracked time since the current STRONG
                BUY/SELL was first observed (snapshotted every 60 s during IST
                market hours, persisted server-side). A trailing{" "}
                <span className="opacity-60">*</span> means the server log
                hasn&apos;t covered this symbol yet — the value falls back to
                this tab&apos;s local observation and may under-report.
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type ScannerHit = {
  symbol: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  metric: number;
  metricLabel: string;
  kind?: string;
  note?: string;
};

type ScannerResult = {
  type: string;
  title: string;
  description: string;
  hits: ScannerHit[];
  fetchedAt: string;
};

function RangeExpansionSection() {
  const [data, setData] = useState<ScannerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rxExpanded, setRxExpanded] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch(
        "/api/in/scanner?type=range-expansion&limit=25",
        {
          cache: "no-store",
          signal: ctrl.signal,
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ScannerResult;
      if (!ctrl.signal.aborted) {
        setData(json);
        setError(null);
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name !== "AbortError") setError(err?.message ?? "Failed");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    const t = setInterval(load, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
      ctrlRef.current?.abort();
    };
  }, [load]);

  const hits = useMemo(() => data?.hits ?? [], [data]);

  const getRangeConfidence = useCallback(
    (h: ScannerHit) => {
      if (hits.length === 0) return h.metric;
      const max = Math.max(...hits.map((x) => Math.abs(x.metric)));
      return max > 0 ? Math.abs(h.metric) / max : 0;
    },
    [hits],
  );

  const getRangeWinrate = useCallback(
    (h: ScannerHit) => {
      const pct = h.changePct ?? 0;
      return Math.min(Math.abs(pct) / 8, 1);
    },
    [],
  );

  const {
    pageItems,
    activeTab,
    setActiveTab,
    page,
    setPage,
    totalPages,
    filteredTotal,
    pageSize,
    tabs,
  } = usePaginationFilter({
    items: hits,
    pageSize: 5,
    getConfidence: getRangeConfidence,
    getWinrate: getRangeWinrate,
    confidenceThreshold: 0.7,
    winrateThreshold: 0.6,
  });

  const pageOffset = (page - 1) * pageSize;
  void pageOffset; // kept for potential future use

  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.15 }}
        className="glass rounded-2xl p-4 sm:p-5 shadow-sm"
      >
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-400/25 to-teal-500/20 ring-1 ring-emerald-400/20">
              <Expand className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold tracking-tight">
                Range Expansion · WR8 + Bullish Trend
              </h2>
              <p className="text-[11px] text-[var(--color-fg-subtle)]">
                F&amp;O longs: today&apos;s H−L is the widest of 8 sessions,
                bullish D/W/M, SMA 20&gt;50&gt;200, vol ≥ 1.5× avg, close in
                upper half of range.{" "}
                <span className="font-medium text-[var(--color-warning)]">Daily setup — swing / next-session, not intraday.</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <FilterTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
            {data?.fetchedAt && (
              <span className="text-[10px] text-muted-foreground">
                {fmtTime(data.fetchedAt)}
              </span>
            )}
            <Link
              href="/in/scanner"
              className="text-[11px] text-blue-500 hover:text-blue-400 hover:underline"
            >
              Open scanner →
            </Link>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-500">
            {error}
          </div>
        )}

        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-sm">
            <thead>
              <SignalTableHead
                extraTrailHeaders={
                  <th className="p-2.5 text-right font-medium">Range / Vol</th>
                }
              />
            </thead>
            <tbody>
              <AnimatePresence>
                {pageItems.map((h, i) => (
                  <SignalTableRow
                    key={h.symbol}
                    hit={h}
                    colSpan={5}
                    index={i}
                    expanded={rxExpanded === h.symbol}
                    onToggle={() =>
                      setRxExpanded((prev) =>
                        prev === h.symbol ? null : h.symbol,
                      )
                    }
                    extraTrailCells={
                      <td className="p-2.5 text-right tabular text-[11px] font-semibold text-[var(--color-fg-muted)]">
                        {h.metricLabel}
                      </td>
                    }
                  />
                ))}
              </AnimatePresence>

              {!data && loading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                    Scanning F&amp;O universe (this may take ~10–20s on the first run)…
                  </td>
                </tr>
              )}
              {data && hits.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                    No range-expansion setups right now — market may be ranging or risk-off.
                  </td>
                </tr>
              )}
              {data && hits.length > 0 && pageItems.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                    No hits match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <PaginationStrip
          page={page}
          totalPages={totalPages}
          filteredTotal={filteredTotal}
          pageSize={pageSize}
          disabled={loading}
          onPrev={() => setPage(page - 1)}
          onNext={() => setPage(page + 1)}
          onJump={setPage}
        />
      </motion.div>
    </section>
  );
}

function ScorePill({ score }: { score: number }) {
  const clamped  = Math.max(-100, Math.min(100, score));
  const positive = clamped >= 0;
  const widthPct = Math.abs(clamped);
  return (
    <div className="inline-flex items-center gap-2 justify-end">
      <span
        className={`text-xs font-bold num ${positive ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"}`}
      >
        {clamped > 0 ? "+" : ""}{clamped}
      </span>
      <div className="relative h-1.5 w-12 rounded-full bg-[var(--color-surface)] overflow-hidden">
        <div
          className={`absolute top-0 bottom-0 rounded-full ${positive ? "bg-[var(--color-bull)]" : "bg-[var(--color-bear)]"}`}
          style={{
            width:   `${widthPct / 2}%`,
            left:    positive ? "50%" : `${50 - widthPct / 2}%`,
            boxShadow: positive
              ? "0 0 6px var(--glow-bull)"
              : "0 0 6px var(--glow-bear)",
          }}
        />
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--color-border)]" />
      </div>
    </div>
  );
}

// ─── Top 5 Stocks for Tomorrow ────────────────────────────────────────────────

type TopPickRow = {
  rank: number;
  symbol: string;
  shortName: string | null;
  sector: string;
  price: number | null;
  changePct: number | null;
  score: number;
  signal: "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL" | "N/A";
  upsidePct: number | null;
  fromSma50Pct: number | null;
  relativeVolume: number | null;
  targetMean: number | null;
};

type TopPicksResponse = {
  picks: TopPickRow[];
  universe: number;
  fetchedAt: string;
};

const SIGNAL_GRADIENT: Record<
  Exclude<TopPickRow["signal"], "N/A">,
  { ring: string; badge: string; icon: string }
> = {
  "STRONG BUY": {
    ring: "ring-emerald-500/40",
    badge: "bg-emerald-600 text-white shadow-emerald-600/30 shadow-md",
    icon: "text-emerald-500",
  },
  BUY: {
    ring: "ring-emerald-400/25",
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: "text-emerald-400",
  },
  HOLD: {
    ring: "ring-border",
    badge: "bg-muted text-muted-foreground",
    icon: "text-muted-foreground",
  },
  SELL: {
    ring: "ring-rose-400/25",
    badge: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
    icon: "text-rose-400",
  },
  "STRONG SELL": {
    ring: "ring-rose-500/40",
    badge: "bg-rose-600 text-white shadow-rose-600/30 shadow-md",
    icon: "text-rose-500",
  },
};

function TopPickCard({ pick, delay }: { pick: TopPickRow; delay: number }) {
  const isBull = pick.signal === "STRONG BUY" || pick.signal === "BUY";
  const isBear = pick.signal === "STRONG SELL" || pick.signal === "SELL";
  const meta =
    pick.signal !== "N/A"
      ? SIGNAL_GRADIENT[pick.signal]
      : { ring: "ring-border", badge: "bg-muted text-muted-foreground", icon: "text-muted-foreground" };

  const DirIcon = isBull ? ArrowUpRight : isBear ? ArrowDownRight : Activity;
  const changeTone = (pick.changePct ?? 0) >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]";

  // 3D tilt
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotX = useSpring(useTransform(my, [-50, 50], [6, -6]), { stiffness: 220, damping: 20 });
  const rotY = useSpring(useTransform(mx, [-50, 50], [-6, 6]), { stiffness: 220, damping: 20 });
  const onMove  = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set(e.clientX - r.left - r.width  / 2);
    my.set(e.clientY - r.top  - r.height / 2);
  };
  const onLeave = () => { mx.set(0); my.set(0); };

  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0,  scale: 1    }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.35, delay, ease: [0.22, 1, 0.36, 1] }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ rotateX: rotX, rotateY: rotY, transformStyle: "preserve-3d" }}
      className={`relative bento-card holo-card ring-1 ring-inset ${meta.ring} flex flex-col gap-3 p-4`}
    >
      {/* Rank badge */}
      <span className="absolute top-3 right-3 grid h-6 w-6 place-items-center rounded-full bg-[var(--color-surface)] text-[10px] font-bold text-[var(--color-fg-muted)] ring-1 ring-[var(--color-border)]">
        #{pick.rank}
      </span>

      {/* Header */}
      <div className="flex items-start gap-2 pr-8" style={{ transform: "translateZ(8px)" }}>
        <div
          className={`mt-0.5 p-1.5 rounded-lg ${
            isBull ? "bg-[color-mix(in_oklch,var(--bull)_14%,transparent)]"
            : isBear ? "bg-[color-mix(in_oklch,var(--bear)_14%,transparent)]"
            : "bg-[var(--color-surface)]"
          }`}
        >
          <DirIcon className={`h-3.5 w-3.5 ${meta.icon}`} />
        </div>
        <div className="min-w-0">
          <a
            href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${pick.symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-bold text-[var(--color-fg)] hover:text-[var(--color-brand)] hover:underline transition-colors"
          >
            {pick.symbol}
          </a>
          {pick.shortName && (
            <p className="text-[10px] text-[var(--color-fg-muted)] truncate">{pick.shortName}</p>
          )}
          <p className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wide">
            {pick.sector}
          </p>
        </div>
      </div>

      {/* Signal badge */}
      {pick.signal !== "N/A" && (
        <span className={`self-start text-[10px] font-bold px-2.5 py-1 rounded-full ${meta.badge}`}>
          {pick.signal}
        </span>
      )}

      {/* Key metrics grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <p className="text-[10px] text-[var(--color-fg-subtle)]">Price</p>
          <p className="font-semibold tabular text-[var(--color-fg)] num">{fmt(pick.price)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--color-fg-subtle)]">Day %</p>
          <p className={`font-semibold tabular num ${changeTone}`}>
            {pick.changePct == null ? "—" : `${pick.changePct >= 0 ? "+" : ""}${pick.changePct.toFixed(2)}%`}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--color-fg-subtle)]">Upside</p>
          <p className="font-semibold tabular text-[var(--color-bull)] num">
            {pick.upsidePct == null ? "—" : `+${pick.upsidePct.toFixed(1)}%`}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--color-fg-subtle)]">vs SMA50</p>
          <p className={`font-semibold tabular num ${(pick.fromSma50Pct ?? 0) >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"}`}>
            {pick.fromSma50Pct == null ? "—" : `${pick.fromSma50Pct >= 0 ? "+" : ""}${pick.fromSma50Pct.toFixed(1)}%`}
          </p>
        </div>
        {pick.relativeVolume != null && (
          <div>
            <p className="text-[10px] text-[var(--color-fg-subtle)]">Rel. Vol</p>
            <p className={`font-semibold tabular num ${pick.relativeVolume >= 1.5 ? "text-[var(--color-warning)]" : "text-[var(--color-fg)]"}`}>
              {pick.relativeVolume.toFixed(2)}×
            </p>
          </div>
        )}
        <div>
          <p className="text-[10px] text-[var(--color-fg-subtle)]">Score</p>
          <ScorePill score={pick.score} />
        </div>
      </div>
    </motion.div>
  );
}

function TopPicksSection() {
  const [data, setData] = useState<TopPicksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch("/api/in/top-picks?limit=5", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TopPicksResponse;
      if (!ctrl.signal.aborted) {
        setData(json);
        setError(null);
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name !== "AbortError") setError(err?.message ?? "Failed to load picks");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void load(), 0);
    // Refresh every 5 minutes — this data is post-market, not tick-sensitive.
    const t = setInterval(load, 5 * 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
      ctrlRef.current?.abort();
    };
  }, [load]);

  const picks = data?.picks ?? [];

  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.18 }}
        className="glass rounded-2xl p-4 sm:p-5 shadow-sm"
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
          <div className="flex items-start gap-2.5">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-violet-400/25 to-fuchsia-500/20 ring-1 ring-violet-400/20 mt-0.5">
              <Star className="h-4 w-4 text-violet-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold tracking-tight">
                Top 5 Stocks for Tomorrow
              </h2>
              <p className="text-[11px] text-[var(--color-fg-subtle)] mt-0.5">
                Highest-conviction NSE F&amp;O picks ranked by quant score across
                all sectors — review after market close.{" "}
                <span className="font-medium text-[var(--color-warning)]">Swing / Next session — not intraday.</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {data?.fetchedAt && (
              <span className="text-[10px] text-muted-foreground">
                Updated {fmtTime(data.fetchedAt)}
              </span>
            )}
            {data?.universe != null && (
              <span className="text-[10px] text-muted-foreground">
                from {data.universe} stocks
              </span>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-full p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
              title="Refresh picks"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Error state */}
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-500">
            {error}
          </div>
        )}

        {/* Cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <AnimatePresence>
            {picks.map((pick, i) => (
              <TopPickCard key={pick.symbol} pick={pick} delay={i * 0.06} />
            ))}
          </AnimatePresence>

          {/* Loading skeletons */}
          {loading && picks.length === 0 &&
            Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl bg-muted/40 ring-1 ring-border p-4 space-y-3 animate-pulse"
              >
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="h-3 w-16 rounded bg-muted" />
                <div className="h-6 w-20 rounded-full bg-muted mt-2" />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <div key={j} className="h-8 rounded bg-muted" />
                  ))}
                </div>
              </div>
            ))}

          {/* Empty state */}
          {!loading && picks.length === 0 && !error && (
            <div className="col-span-full py-10 text-center text-sm text-muted-foreground">
              No picks available — the scanner may still be warming up.
            </div>
          )}
        </div>

        {/* Footer note */}
        {picks.length > 0 && (
          <p className="mt-4 text-[10px] text-muted-foreground/70">
            <b>Score</b>: −100…+100 composite from SMA50/200 trend, day move,
            analyst target, RSI, ADX, volume and delivery quality.{" "}
            <b>Upside</b>: % to max(52-week high, analyst mean target).
            Not financial advice — always apply your own risk management.
          </p>
        )}
      </motion.div>
    </section>
  );
}
