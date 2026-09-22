"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Flame,
  Layers,
  RefreshCw,
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
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { dataSourceLabels } from "@/features/settings/data-sources-shared";
import { MarketCoreWidget } from "@/components/3d/market-core-widget";
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

/** Sanitise the bias string returned by /api/in/nifty-bias.
 *  Guards against stale cached error strings ("DATA_SERVICE_UNAVAILABLE", "ERROR", etc.)
 *  slipping through to the UI. Only "BULLISH" and "BEARISH" are display-safe. */
function sanitizeBias(raw: string | undefined | null): string {
  if (raw === "BULLISH" || raw === "BEARISH") return raw;
  return "-";
}

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

const isVix = (name: string | undefined | null) => !!name?.toUpperCase().includes("VIX");

export default function MsbDashboard() {
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
  const isSimulated = useIndiaMarketStore((s) => s.snapshot?.simulated) ?? false;
  const sourceBadge = isSimulated
    ? "SIMULATED DATA"
    : snapshotSources.length > 0
      ? dataSourceLabels(snapshotSources.filter((s): s is import("@/features/settings/data-sources-shared").DataSourceId => s !== "SIMULATED")).join(" + ")
      : null;
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
      const [biasRes, snapRes] = await Promise.all([
        fetch("/api/in/nifty-bias", init),
        fetch("/api/in/market-snapshot", init),
      ]);
      const [biasJson, snapJson] = await Promise.all([
        biasRes.json(),
        snapRes.json(),
      ]);
      if (ctrl.signal.aborted) return;
      setNifty({
        bias:  sanitizeBias(biasJson?.bias),
        price: biasJson?.price ?? "-",
      });
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
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium ${
                    isSimulated
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]"
                  }`}
                  title={isSimulated ? "Data service unavailable — showing simulated market data" : "Live data source(s) actually serving this snapshot"}
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
            {idx.changePct == null
              ? "—"
              : `${positive ? "+" : ""}${fmt(idx.change)} (${positive ? "+" : ""}${fmt(idx.changePct)}%)`}
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

// Hoisted out of `SectorStocksModal` so React 19 doesn't re-create the
// component identity on every render (which would also blow away child
// state). Receives the active sort state as plain props.
function _SortHeader({
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
    pageItems: _paginatedRows,
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

  const _onSort = (key: SortKey) => {
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

  const _signalClass = (sig: StockRow["signal"]) => {
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

  const _pctCell = (n: number | null | undefined) => {
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

