"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import { RefreshCw } from "lucide-react";

import { BentoGrid, BentoCell } from "@/components/layout/BentoGrid";
import { PageTransition } from "@/components/layout/PageTransition";
import { PageHeader } from "@/components/layout/PageHeader";
import { RegimeBanner } from "@/components/india/dashboard/regime-banner";
import { IndexStrip } from "@/components/india/dashboard/index-strip";
import { Top5StocksWidget } from "@/components/india/dashboard/top5-stocks-widget";

import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useUIStore } from "@/store/uiStore";
import { useRegime } from "@/lib/regime-context";
import { SPRING_GENTLE, SPRING_MICRO } from "@/lib/motion-presets";
import type { TopPickRow } from "@/app/api/in/top-picks/route";

// ── Dynamic imports — keep heavy 3D and chart bundles out of initial load ──

const MarketCoreWidget = dynamic(
  () =>
    import("@/components/3d/market-core-widget").then((m) => ({
      default: m.MarketCoreWidget,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full min-h-[260px] animate-pulse items-center justify-center rounded-[var(--radius-panel)] bg-[var(--color-surface)]"
        aria-label="Loading market core"
        role="status"
      >
        <div className="h-24 w-24 rounded-full bg-[color-mix(in_oklch,var(--color-brand)_12%,transparent)]" />
      </div>
    ),
  },
);

const OrderFlowPanel = dynamic(
  () =>
    import("@/components/india/dashboard/order-flow-panel").then((m) => ({
      default: m.OrderFlowPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="h-40 animate-pulse rounded-[var(--radius-panel)] bg-[var(--color-surface)]" />
    ),
  },
);

// ── Regime sync ────────────────────────────────────────────────────────────

/**
 * Reads the India snapshot and syncs the derived regime to UIStore so that
 * the RegimeBanner, aurora background, and PageHeader stay in sync.
 *
 * Bias mapping: BULLISH → BULL, BEARISH → BEAR, etc.
 */
function useRegimeSync(niftyBias: string) {
  const setRegime = useUIStore((s) => s.setRegime);

  React.useEffect(() => {
    const b = niftyBias.toUpperCase();
    if (b === "BULLISH") setRegime("BULL");
    else if (b === "BEARISH") setRegime("BEAR");
    else if (b === "SIDEWAYS") setRegime("SIDEWAYS");
    else if (b === "HIGH_VOL" || b === "HIGHVOL") setRegime("HIGH_VOL");
    // Keep UNKNOWN if unrecognised (don't call setRegime to avoid flicker)
  }, [niftyBias, setRegime]);
}

// ── IntersectionObserver hook for lazy-mount of the 3D sphere ─────────────

function useInView(ref: React.RefObject<Element | null>): boolean {
  const [inView, setInView] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.1 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [ref, inView]);

  return inView;
}

// ── MarketCoreCell — animated entrance + IntersectionObserver mount ───────

function MarketCoreCell({ niftyBias }: { niftyBias: string }) {
  const reducedMotion = useReducedMotion();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const isVisible = useInView(containerRef);

  return (
    <div ref={containerRef} className="h-full min-h-[260px]">
      {isVisible && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reducedMotion ? { duration: 0 } : SPRING_GENTLE}
          className="h-full"
        >
          <MarketCoreWidget niftyBias={niftyBias} height={280} />
        </motion.div>
      )}
    </div>
  );
}

// ── Main client component ─────────────────────────────────────────────────

/**
 * IndiaOverviewClient
 *
 * Full client-side India Overview page — BentoGrid layout matching Requirement 6.
 * Fetches:
 *  - /api/in/msb-signals (MSB signals table)
 *  - /api/in/nifty-bias  (bias + regime)
 *  - /api/in/market-snapshot (indices for IndexStrip)
 *  - /api/in/top-picks   (Top 5 Stocks widget)
 *
 * All data fetched together so a single Refresh button handles everything.
 */
export function IndiaOverviewClient() {
  const { regime } = useRegime();

  // ── Store reads ──────────────────────────────────────────────────────────
  const snapshot = useIndiaMarketStore((s) => s.snapshot);
  const setSnapshot = useIndiaMarketStore((s) => s.setSnapshot);

  // ── Local state ──────────────────────────────────────────────────────────
  const [niftyBias, setNiftyBias] = React.useState("-");
  const [msbData, setMsbData] = React.useState<MsbSignalRow[]>([]);
  const [topPicks, setTopPicks] = React.useState<TopPickRow[]>([]);
  const [loading, setLoading] = React.useState(false);

  // ── Regime sync ──────────────────────────────────────────────────────────
  useRegimeSync(niftyBias);

  // ── Abort controller ref ─────────────────────────────────────────────────
  const ctrlRef = React.useRef<AbortController | null>(null);
  const inFlightRef = React.useRef(false);

  const fetchAll = React.useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    try {
      setLoading(true);
      const init = { cache: "no-store" as const, signal: ctrl.signal };

      const [signalsRes, biasRes, snapRes, picksRes] = await Promise.all([
        fetch("/api/in/msb-signals", init),
        fetch("/api/in/nifty-bias", init),
        fetch("/api/in/market-snapshot", init),
        fetch("/api/in/top-picks?limit=5", init),
      ]);

      if (ctrl.signal.aborted) return;

      const [signalsJson, biasJson, snapJson, picksJson] = await Promise.all([
        signalsRes.json(),
        biasRes.json(),
        snapRes.json(),
        picksRes.json(),
      ]);

      if (ctrl.signal.aborted) return;

      setMsbData(Array.isArray(signalsJson) ? signalsJson : []);
      setNiftyBias(biasJson?.bias ?? "-");
      setSnapshot(snapJson);
      setTopPicks(Array.isArray(picksJson?.picks) ? picksJson.picks : []);
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name !== "AbortError") console.error("[IndiaOverview]", err);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [setSnapshot]);

  React.useEffect(() => {
    const t = setTimeout(() => void fetchAll(), 0);
    const interval = setInterval(fetchAll, 10_000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
      ctrlRef.current?.abort();
    };
  }, [fetchAll]);

  // ── Index names sourced from snapshot ────────────────────────────────────
  const indices = snapshot?.indices ?? [];
  const hasNifty = indices.some((i) => i.name?.toUpperCase() === "NIFTY 50");
  const hasBank = indices.some((i) => i.name?.toUpperCase() === "NIFTY BANK");
  const hasFin = indices.some((i) =>
    i.name?.toUpperCase().includes("FIN SERVICE") ||
    i.name?.toUpperCase().includes("FINNIFTY"),
  );

  return (
    <PageTransition>
      {/* ── Regime Banner strip ────────────────────────────────────────── */}
      <RegimeBanner />

      {/* ── Page Header ────────────────────────────────────────────────── */}
      <div className="px-4 pt-4">
        <PageHeader
          title="India Overview"
          subtitle="Live NSE market snapshot — indices, signals &amp; top picks"
          regime={regime !== "UNKNOWN" ? regime : undefined}
          action={
            <button
              type="button"
              onClick={() => void fetchAll()}
              disabled={loading}
              aria-label="Refresh dashboard data"
              className="flex items-center gap-1.5 rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-brand)] hover:text-[var(--color-brand)]"
              style={{ color: "var(--color-fg-muted)" }}
            >
              <RefreshCw
                size={13}
                aria-hidden
                className={loading ? "animate-spin" : ""}
              />
              Refresh
            </button>
          }
        />
      </div>

      {/* ── BentoGrid ──────────────────────────────────────────────────── */}
      <div className="px-4 pb-6">
        <BentoGrid cols={12} gap="gap-3">
          {/* ─────────────── Row 1-3: Market Core (4) + Index strips (5) + Top 5 (3) */}

          {/* Market Core — colSpan 4, rowSpan 3 */}
          <BentoCell colSpan={4} rowSpan={3} className="min-h-[260px]">
            <MarketCoreCell niftyBias={niftyBias} />
          </BentoCell>

          {/* NIFTY 50 strip — colSpan 5, rowSpan 1 */}
          <BentoCell colSpan={5} rowSpan={1}>
            <IndexStrip
              indexName="NIFTY 50"
              label="NIFTY 50"
              className="h-full min-h-[80px]"
            />
          </BentoCell>

          {/* Top 5 Stocks — colSpan 3, rowSpan 3 */}
          <BentoCell colSpan={3} rowSpan={3}>
            <Top5StocksWidget picks={topPicks} isLoading={loading && topPicks.length === 0} />
          </BentoCell>

          {/* BANKNIFTY strip — colSpan 5, rowSpan 1 */}
          <BentoCell colSpan={5} rowSpan={1}>
            <IndexStrip
              indexName="NIFTY BANK"
              label="BANKNIFTY"
              className="h-full min-h-[80px]"
            />
          </BentoCell>

          {/* FINNIFTY strip — colSpan 5, rowSpan 1 */}
          <BentoCell colSpan={5} rowSpan={1}>
            <IndexStrip
              indexName="NIFTY FIN SERVICE"
              label="FINNIFTY"
              className="h-full min-h-[80px]"
            />
          </BentoCell>

          {/* ─────────────── Row 4+: MSB Signals (8) + Order Flow VPIN (4) */}

          {/* MSB Signals table — colSpan 8 */}
          <BentoCell colSpan={8}>
            <MsbSignalsPanel
              data={msbData}
              loading={loading}
              niftyBias={niftyBias}
            />
          </BentoCell>

          {/* Order Flow VPIN — colSpan 4 */}
          <BentoCell colSpan={4}>
            <div
              className="h-full rounded-[var(--radius-panel)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] overflow-hidden"
            >
              <OrderFlowPanel symbol="NIFTY" />
            </div>
          </BentoCell>
        </BentoGrid>
      </div>
    </PageTransition>
  );
}

// ── Local types for MSB signals ───────────────────────────────────────────

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

// ── MSB Signals Panel — compact TanStack-free table ───────────────────────

interface MsbSignalsPanelProps {
  data: MsbSignalRow[];
  loading: boolean;
  niftyBias: string;
}

function MsbSignalsPanel({ data, loading, niftyBias: _niftyBias }: MsbSignalsPanelProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div
      data-density="compact"
      className="h-full rounded-[var(--radius-panel)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] overflow-hidden flex flex-col"
    >
      {/* Panel header */}
      <div
        className="flex items-center justify-between border-b border-[var(--color-panel-border)] px-4"
        style={{ height: "40px", minHeight: "40px" }}
      >
        <h3 className="text-sm font-semibold" style={{ color: "var(--color-fg)" }}>
          MSB–OB Intraday Signals
        </h3>
        <span className="text-[11px]" style={{ color: "var(--color-fg-muted)" }}>
          {loading && data.length === 0
            ? "Loading…"
            : `${data.length} setup${data.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr
              className="border-b border-[var(--color-panel-border)]"
              style={{ background: "var(--color-surface)" }}
            >
              <th className="px-3 py-2 text-left font-medium uppercase tracking-wide" style={{ color: "var(--color-fg-subtle)" }}>Symbol</th>
              <th className="px-3 py-2 text-left font-medium uppercase tracking-wide" style={{ color: "var(--color-fg-subtle)" }}>Side</th>
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide" style={{ color: "var(--color-fg-subtle)" }}>Strength</th>
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide" style={{ color: "var(--color-fg-subtle)" }}>Entry</th>
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide" style={{ color: "var(--color-fg-subtle)" }}>Stop</th>
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide" style={{ color: "var(--color-fg-subtle)" }}>Target</th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-sm"
                  style={{ color: "var(--color-fg-muted)" }}
                >
                  No setups available — run the Python scanner during market hours.
                </td>
              </tr>
            )}
            {data.length === 0 && loading && (
              <>
                {Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-[var(--color-panel-border)]">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-3 py-2">
                        <div className="h-3 animate-pulse rounded bg-[var(--color-surface)]" />
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            )}
            {data.slice(0, 15).map((row, i) => {
              const isBuy = row.Side?.toUpperCase() === "BUY";
              const sideColor = isBuy
                ? "var(--color-data-positive)"
                : "var(--color-data-negative)";
              const strength = Number(row.Strength) || 0;

              return (
                <motion.tr
                  key={`${row.Symbol}-${i}`}
                  initial={reducedMotion ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { ...SPRING_MICRO, delay: i * 0.03 }
                  }
                  className="border-b border-[var(--color-panel-border)] transition-colors hover:bg-[var(--color-surface-hover)]"
                >
                  <td
                    className="px-3 py-1.5 font-semibold"
                    style={{ color: "var(--color-fg)", fontFamily: "var(--font-data)" }}
                  >
                    {row.Symbol}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                      style={{
                        color: sideColor,
                        background: `color-mix(in oklch, ${sideColor} 12%, transparent)`,
                      }}
                    >
                      {row.Side}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {/* Strength bar */}
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, strength)}%`,
                            background: "var(--color-data-positive)",
                          }}
                        />
                      </div>
                      <span
                        className="min-w-[36px] text-right tabular-nums"
                        style={{ color: "var(--color-fg-muted)", fontFamily: "var(--font-data)" }}
                      >
                        {strength.toFixed(1)}
                      </span>
                    </div>
                  </td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: "var(--color-fg)", fontFamily: "var(--font-data)" }}
                  >
                    {row.Entry}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: "var(--color-data-negative)", fontFamily: "var(--font-data)" }}
                  >
                    {row.SL_ATR}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: "var(--color-data-positive)", fontFamily: "var(--font-data)" }}
                  >
                    {row.TGT_ATR}
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
