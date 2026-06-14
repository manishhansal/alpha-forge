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
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { dataSourceLabels } from "@/features/settings/data-sources-shared";

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
      setData(Array.isArray(signalsJson) ? signalsJson : []);
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
      {/* Hero / Indices Row */}
      <section>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mb-4 flex items-end justify-between gap-3"
        >
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                Market Pulse
              </h1>
              {sourceBadge && (
                <span
                  className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title="Live data source(s) actually serving this snapshot"
                >
                  {sourceBadge}
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Live snapshot of Indian indices and sectoral momentum
            </p>
          </div>
          <Button
            onClick={fetchData}
            disabled={loading}
            size="sm"
            variant="outline"
            className="rounded-full"
          >
            <RefreshCw
              className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </motion.div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4 perspective-1000">
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
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-gradient-to-br from-amber-400/30 to-rose-500/30">
                <Flame className="h-4 w-4 text-amber-500" />
              </div>
              <h2 className="text-base sm:text-lg font-semibold">
                NIFTY Sectoral Heatmap
              </h2>
            </div>
            <span className="text-[10px] sm:text-xs text-muted-foreground">
              {snapshot.fetchedAt
                ? `Updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`
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

      {/* Range Expansion (WR8 + Bullish Trend) — F&O long-side scanner */}
      <RangeExpansionSection />

      {/* Signals Table */}
      <section>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.2 }}
          className="glass rounded-2xl p-4 sm:p-5 shadow-sm"
        >
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-gradient-to-br from-blue-400/30 to-violet-500/30">
                <Sparkles className="h-4 w-4 text-blue-500" />
              </div>
              <h2 className="text-base sm:text-lg font-semibold">
                MSB–OB Intraday Signals
              </h2>
            </div>
            <span className="text-[10px] sm:text-xs text-muted-foreground">
              {data.length} setup{data.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-border/60 text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="p-2.5 font-medium">Symbol</th>
                  <th className="p-2.5 font-medium">Side</th>
                  <th className="p-2.5 font-medium text-right">Entry</th>
                  <th className="p-2.5 font-medium text-right">SL (ATR)</th>
                  <th className="p-2.5 font-medium text-right">Target</th>
                  <th className="p-2.5 font-medium text-right">Strike</th>
                  <th className="p-2.5 font-medium">Type</th>
                  <th className="p-2.5 font-medium text-right">Strength</th>
                  <th className="p-2.5"></th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {data.map((row, i) => (
                    <motion.tr
                      key={`${row.Symbol}-${i}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: 0.25,
                        delay: Math.min(i * 0.03, 0.4),
                      }}
                      className="border-b border-border/40 hover:bg-muted/40 transition-colors"
                    >
                      <td className="p-2.5 font-medium">
                        <a
                          href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${String(row.Symbol).replace(".NS", "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:text-blue-400 hover:underline"
                        >
                          {row.Symbol}
                        </a>
                      </td>
                      <td className="p-2.5">
                        <SideBadge side={row.Side} />
                      </td>
                      <td className="p-2.5 text-right tabular">{row.Entry}</td>
                      <td className="p-2.5 text-right tabular">{row.SL_ATR}</td>
                      <td className="p-2.5 text-right tabular">{row.TGT_ATR}</td>
                      <td className="p-2.5 text-right tabular">{row.Strike}</td>
                      <td className="p-2.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                          {row.Type}
                        </span>
                      </td>
                      <td className="p-2.5 text-right tabular font-semibold">
                        {Number(row.Strength).toFixed(2)}
                      </td>
                      <td className="p-2.5">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => addJournal(row)}
                          title="Add to journal"
                        >
                          <PlusCircle className="h-3 w-3 mr-1" />
                          Journal
                        </Button>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>

                {data.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={9}
                      className="p-8 text-center text-muted-foreground text-sm"
                    >
                      No setups available — run the Python scanner during
                      market hours.
                    </td>
                  </tr>
                )}
                {loading && data.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="p-8 text-center text-muted-foreground text-sm"
                    >
                      Loading signals…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
  const pct = idx.changePct ?? 0;
  const up = pct >= 0;
  const inverted = isVix(idx.name);

  // For VIX: rising = bad (red), falling = good (green)
  const tone = inverted
    ? up
      ? "text-rose-500"
      : "text-emerald-500"
    : up
      ? "text-emerald-500"
      : "text-rose-500";

  const accent = inverted
    ? up
      ? "from-rose-500/20 to-orange-500/10"
      : "from-emerald-500/20 to-teal-500/10"
    : up
      ? "from-emerald-500/20 to-teal-500/10"
      : "from-rose-500/20 to-orange-500/10";

  // 3D tilt
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useSpring(useTransform(y, [-50, 50], [6, -6]), {
    stiffness: 200,
    damping: 18,
  });
  const rotateY = useSpring(useTransform(x, [-50, 50], [-6, 6]), {
    stiffness: 200,
    damping: 18,
  });

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    x.set(e.clientX - rect.left - rect.width / 2);
    y.set(e.clientY - rect.top - rect.height / 2);
  };
  const onMouseLeave = () => {
    x.set(0);
    y.set(0);
  };

  const chartHref = `/in/chart/${encodeURIComponent(idx.symbol)}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
      className="relative rounded-2xl overflow-hidden glass glow-on-hover"
    >
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-br ${accent} opacity-80 pointer-events-none`}
      />
      <Link
        href={chartHref}
        className="relative block p-4 sm:p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded-2xl"
        style={{ transform: "translateZ(20px)" }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] sm:text-xs font-medium uppercase tracking-wider text-muted-foreground truncate">
            {idx.name}
          </div>
          {niftyBias && niftyBias !== "-" && (
            <span
              className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                niftyBias === "BULLISH"
                  ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                  : niftyBias === "BEARISH"
                    ? "bg-rose-500/20 text-rose-700 dark:text-rose-400"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {niftyBias}
            </span>
          )}
        </div>

        <div className="mt-1.5 text-2xl sm:text-3xl font-semibold tabular tracking-tight">
          {fmt(idx.price)}
        </div>

        <div
          className={`mt-1 flex items-center gap-1 text-xs sm:text-sm font-medium ${tone}`}
        >
          {up ? (
            <ArrowUpRight className="h-3.5 w-3.5" />
          ) : (
            <ArrowDownRight className="h-3.5 w-3.5" />
          )}
          <span className="tabular">
            {up ? "+" : ""}
            {fmt(idx.change)} ({up ? "+" : ""}
            {fmt(idx.changePct)}%)
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
  const pct = sector.changePct ?? 0;
  const up = pct >= 0;
  const intensity = Math.min(Math.abs(pct) / 3, 1);
  const alpha = 0.18 + intensity * 0.65;

  const bg = up
    ? `rgba(16, 185, 129, ${alpha})`
    : `rgba(244, 63, 94, ${alpha})`;

  // High intensity → always white (the tile background is saturated enough).
  // Low intensity → readable color that adapts to the active theme.
  const textTone =
    intensity > 0.5
      ? "text-white"
      : up
        ? "text-emerald-800 dark:text-emerald-200"
        : "text-rose-800 dark:text-rose-200";

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, delay, ease: "easeOut" }}
      whileHover={{
        scale: 1.06,
        rotateX: -4,
        rotateY: 4,
        z: 30,
      }}
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      style={{
        backgroundColor: bg,
        transformStyle: "preserve-3d",
      }}
      className={`rounded-xl p-3 text-left cursor-pointer border border-white/5 shadow-sm hover:shadow-xl transition-shadow focus:outline-none focus:ring-2 focus:ring-blue-400 ${textTone}`}
      title={`${sector.symbol} — click for F&O stocks`}
    >
      <div className="text-[11px] font-semibold truncate">{sector.name}</div>
      <div className="mt-1 text-sm font-bold tabular">
        {up ? "+" : ""}
        {fmt(pct)}%
      </div>
      <div className="text-[10px] opacity-80 tabular">{fmt(sector.price)}</div>
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
            className="bg-card text-card-foreground rounded-2xl shadow-2xl border border-border w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 sm:p-5 border-b border-border/60 bg-gradient-to-br from-background to-muted/30">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 shrink-0">
                  <Layers className="h-4 w-4 text-blue-500" />
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
                    <span>{rows.length} stocks</span>
                    {resp?.fetchedAt && (
                      <>
                        <span>·</span>
                        <span>
                          updated{" "}
                          {new Date(resp.fetchedAt).toLocaleTimeString()}
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

            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur z-10 border-b border-border/60">
                  <tr>
                    <SortHeader
                      label="Symbol"
                      k="symbol"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Price"
                      k="price"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Day %"
                      k="changePct"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="vs SMA50"
                      k="fromSma50Pct"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Upside"
                      k="upsidePct"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Downside"
                      k="downsidePct"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Score"
                      k="score"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Signal"
                      k="signal"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                    <SortHeader
                      label="Held for"
                      k="heldFor"
                      align="right"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence>
                    {sortedRows.map((r, i) => {
                      const age = ageFor(r);
                      const ageMs = age?.ms ?? null;
                      const ageSource = age?.source ?? null;
                      const isStrong =
                        r.signal === "STRONG BUY" ||
                        r.signal === "STRONG SELL";
                      const ageTone =
                        r.signal === "STRONG BUY"
                          ? "text-emerald-500"
                          : r.signal === "STRONG SELL"
                            ? "text-rose-500"
                            : "text-muted-foreground";
                      const sinceMs =
                        ageSource === "server"
                          ? r.signalSince
                          : signalAges[r.symbol]?.since;
                      return (
                        <motion.tr
                          key={r.symbol}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{
                            duration: 0.2,
                            delay: Math.min(i * 0.015, 0.3),
                          }}
                          className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                        >
                          <td className="p-2.5 font-medium">
                            <a
                              href={`https://in.tradingview.com/chart/CR5K0NSR/?symbol=NSE%3A${r.symbol}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:text-blue-400 hover:underline"
                            >
                              {r.symbol}
                            </a>
                            {r.shortName && (
                              <div className="text-[10px] text-muted-foreground truncate max-w-[180px]">
                                {r.shortName}
                              </div>
                            )}
                          </td>
                          <td className="p-2.5 text-right tabular">
                            {fmt(r.price)}
                          </td>
                          <td className="p-2.5 text-right tabular">
                            {pctCell(r.changePct)}
                          </td>
                          <td className="p-2.5 text-right tabular">
                            {pctCell(r.fromSma50Pct)}
                          </td>
                          <td className="p-2.5 text-right tabular">
                            {r.upsidePct == null ? (
                              <span className="opacity-40">—</span>
                            ) : (
                              <span className="text-emerald-500 font-medium">
                                +{r.upsidePct.toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td className="p-2.5 text-right tabular">
                            {r.downsidePct == null ? (
                              <span className="opacity-40">—</span>
                            ) : (
                              <span className="text-rose-500 font-medium">
                                -{r.downsidePct.toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td className="p-2.5 text-right tabular">
                            <ScorePill score={r.score} />
                          </td>
                          <td className="p-2.5">
                            <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
                              <span
                                className={`text-[10px] font-bold px-2 py-1 rounded-full ${signalClass(r.signal)}`}
                              >
                                {r.signal}
                              </span>
                              {isStrong && ageMs != null && (
                                <span
                                  className={`text-[10px] tabular ${ageTone}`}
                                  title={`${r.signal} since ${new Date(
                                    sinceMs ?? nowTs,
                                  ).toLocaleString()} · source: ${
                                    ageSource === "server"
                                      ? "server snapshot log"
                                      : "local observation only"
                                  }`}
                                >
                                  {formatDuration(ageMs)}
                                  {ageSource === "local" && (
                                    <span
                                      aria-label="local-only (server snapshot not yet available)"
                                      className="ml-0.5 opacity-60"
                                    >
                                      *
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-2.5 text-right tabular text-xs">
                            {ageMs == null ? (
                              <span className="opacity-40">—</span>
                            ) : (
                              <span
                                className={`font-medium ${ageTone}`}
                                title={`${r.signal} since ${new Date(
                                  sinceMs ?? nowTs,
                                ).toLocaleString()} · source: ${
                                  ageSource === "server"
                                    ? "server snapshot log"
                                    : "local observation only"
                                }`}
                              >
                                {formatDuration(ageMs)}
                                {ageSource === "local" && (
                                  <span className="ml-0.5 opacity-60">*</span>
                                )}
                              </span>
                            )}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>

                  {sortedRows.length === 0 && !loading && (
                    <tr>
                      <td
                        colSpan={9}
                        className="p-8 text-center text-muted-foreground text-sm"
                      >
                        No stocks in this sector.
                      </td>
                    </tr>
                  )}
                  {sortedRows.length === 0 && loading && (
                    <tr>
                      <td
                        colSpan={9}
                        className="p-8 text-center text-muted-foreground text-sm"
                      >
                        Loading sector data…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-3 sm:p-4 border-t border-border/60 bg-muted/30 text-[10px] sm:text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
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
        "/api/in/scanner?type=range-expansion&limit=10",
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
    // Defer the initial scan onto the next task so the eslint
    // `react-hooks/set-state-in-effect` rule sees state updates only via an
    // external-system callback (the timer), not a synchronous effect body.
    const initial = setTimeout(() => void load(), 0);
    // The scanner pass is heavy server-side (caches 5 min) so polling every
    // 60 s is fine even though it triggers state updates.
    const t = setInterval(load, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
      ctrlRef.current?.abort();
    };
  }, [load]);

  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.15 }}
        className="glass rounded-2xl p-4 sm:p-5 shadow-sm"
      >
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-gradient-to-br from-emerald-400/30 to-teal-500/30">
              <Expand className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold">
                Range Expansion · WR8 + Bullish Trend
              </h2>
              <p className="text-[11px] text-muted-foreground">
                F&amp;O longs: today&apos;s H−L is the widest of 8 sessions,
                bullish D/W/M, SMA 20&gt;50&gt;200, vol ≥ 1.5× avg, close in
                upper half of range.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data?.fetchedAt && (
              <span className="text-[10px] text-muted-foreground">
                {new Date(data.fetchedAt).toLocaleTimeString()}
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
              <tr className="text-left border-b border-border/60 text-muted-foreground text-xs uppercase tracking-wide">
                <th className="p-2.5 font-medium">#</th>
                <th className="p-2.5 font-medium">Symbol</th>
                <th className="p-2.5 font-medium text-right">Close</th>
                <th className="p-2.5 font-medium text-right">Day %</th>
                <th className="p-2.5 font-medium text-right">Range / Vol</th>
                <th className="p-2.5 font-medium hidden md:table-cell">
                  Trend
                </th>
                <th className="p-2.5"></th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence>
                {data?.hits.map((h, i) => (
                  <motion.tr
                    key={h.symbol}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.4) }}
                    className="border-b border-border/40 hover:bg-muted/40 transition-colors"
                  >
                    <td className="p-2.5 text-muted-foreground">{i + 1}</td>
                    <td className="p-2.5 font-medium">
                      <Link
                        href={`/in/chart/${encodeURIComponent(h.symbol)}`}
                        className="text-blue-500 hover:text-blue-400 hover:underline"
                      >
                        {h.symbol}
                      </Link>
                    </td>
                    <td className="p-2.5 text-right tabular">{fmt(h.price)}</td>
                    <td
                      className={`p-2.5 text-right tabular font-medium ${
                        (h.changePct ?? 0) >= 0
                          ? "text-emerald-500"
                          : "text-rose-500"
                      }`}
                    >
                      {h.changePct == null
                        ? "—"
                        : `${h.changePct >= 0 ? "+" : ""}${h.changePct.toFixed(2)}%`}
                    </td>
                    <td className="p-2.5 text-right tabular text-xs font-semibold">
                      {h.metricLabel}
                    </td>
                    <td className="p-2.5 hidden md:table-cell text-[11px] text-muted-foreground max-w-[260px] truncate">
                      {h.note ?? ""}
                    </td>
                    <td className="p-2.5">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                        WR8
                      </span>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>

              {!data && loading && (
                <tr>
                  <td
                    colSpan={7}
                    className="p-6 text-center text-muted-foreground text-sm"
                  >
                    Scanning F&amp;O universe (this may take ~10–20s on the
                    first run)…
                  </td>
                </tr>
              )}
              {data && data.hits.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={7}
                    className="p-6 text-center text-muted-foreground text-sm"
                  >
                    No range-expansion setups right now — market may be
                    ranging or risk-off.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </section>
  );
}

function ScorePill({ score }: { score: number }) {
  const clamped = Math.max(-100, Math.min(100, score));
  const positive = clamped >= 0;
  const widthPct = Math.abs(clamped);
  return (
    <div className="inline-flex items-center gap-2 justify-end">
      <span
        className={`text-xs font-semibold ${positive ? "text-emerald-500" : "text-rose-500"}`}
      >
        {clamped > 0 ? "+" : ""}
        {clamped}
      </span>
      <div className="relative h-1.5 w-12 rounded-full bg-muted overflow-hidden">
        <div
          className={`absolute top-0 bottom-0 ${positive ? "bg-emerald-500" : "bg-rose-500"}`}
          style={{
            width: `${widthPct / 2}%`,
            left: positive ? "50%" : `${50 - widthPct / 2}%`,
          }}
        />
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-border" />
      </div>
    </div>
  );
}
