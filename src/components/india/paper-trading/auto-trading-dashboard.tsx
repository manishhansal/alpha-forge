"use client";

/**
 * Auto Paper-Trading Analytics Dashboard
 *
 * Shows the intelligent engine's performance across selectable time ranges
 * with an equity curve, per-day breakdown table, and aggregate stat tiles.
 */

import * as React from "react";
import {
  Activity,
  BarChart3,
  Brain,
  Calendar,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtPct } from "@/lib/india/format";
import type {
  AnalyticsRange,
  AutoTradingAnalytics,
  DaySessionSummary,
} from "@/features/india/paper-trading/auto-trader";

// ─── Constants ────────────────────────────────────────────────────────────────

const RANGES: { id: AnalyticsRange; label: string }[] = [
  { id: "1d",  label: "Today"   },
  { id: "7d",  label: "7 days"  },
  { id: "15d", label: "15 days" },
  { id: "30d", label: "30 days" },
  { id: "6mo", label: "6 months"},
  { id: "1y",  label: "1 year"  },
  { id: "all", label: "All time"},
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pnlClass(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "text-[var(--color-fg-muted)]";
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
}
function fmtInr(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}₹${fmt(Math.abs(n))}`;
}
function fmtWr(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

// ─── Equity Sparkline (pure SVG) ──────────────────────────────────────────────

function EquityCurve({
  data,
}: {
  data: Array<{ date: string; equity: number; pnlPct: number }>;
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-32 items-center justify-center text-[12px] text-[var(--color-fg-muted)]">
        Not enough data to draw a curve yet.
      </div>
    );
  }

  const W = 600; const H = 120; const PAD = 8;
  const values = data.map((d) => d.equity);
  const minV   = Math.min(...values);
  const maxV   = Math.max(...values);
  const range  = maxV - minV || 1;

  const pts = data.map((d, i) => {
    const x = PAD + (i / (data.length - 1)) * (W - PAD * 2);
    const y = PAD + ((maxV - d.equity) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lastEquity = values[values.length - 1];
  const lineColor  = lastEquity >= 0 ? "#10b981" : "#f43f5e";

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 128 }}>
        {/* zero line */}
        {minV < 0 && maxV > 0 && (
          <line
            x1={PAD} y1={PAD + ((maxV) / range) * (H - PAD * 2)}
            x2={W - PAD} y2={PAD + ((maxV) / range) * (H - PAD * 2)}
            stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4,4"
          />
        )}
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke={lineColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* last point dot */}
        {(() => {
          const [lastPt] = pts.slice(-1);
          const [lx, ly] = lastPt.split(",").map(Number);
          return <circle cx={lx} cy={ly} r="4" fill={lineColor} />;
        })()}
      </svg>
      <div className="flex items-center justify-between px-3 pb-2 text-[10px] text-[var(--color-fg-subtle)]">
        <span>{data[0].date}</span>
        <span className={cn("font-semibold text-[11px]", pnlClass(lastEquity))}>
          {fmtInr(lastEquity)} cumulative
        </span>
        <span>{data[data.length - 1].date}</span>
      </div>
    </div>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

function StatTile({
  label, value, sub, tone, icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear" | "neutral";
  icon?: typeof TrendingUp;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <span className={cn("text-xl font-semibold tabular-nums",
        tone === "bull" ? "text-emerald-600 dark:text-emerald-400"
        : tone === "bear" ? "text-rose-600 dark:text-rose-400"
        : "text-[var(--color-fg)]"
      )}>{value}</span>
      {sub && <span className="text-[10px] text-[var(--color-fg-subtle)]">{sub}</span>}
    </div>
  );
}

// ─── Per-day breakdown table ──────────────────────────────────────────────────

function DayRow({ day }: { day: DaySessionSummary }) {
  const win = day.realisedPnl > 0;
  const loss = day.realisedPnl < 0;
  return (
    <tr className="border-b border-[var(--color-border)]/40 hover:bg-[var(--color-bg-elevated)] transition-colors">
      <td className="p-2.5 text-sm font-medium text-[var(--color-fg)]">{day.tradeDate}</td>
      <td className="p-2.5 text-right tabular text-sm">{day.totalTrades}</td>
      <td className="p-2.5 text-right tabular text-sm text-emerald-600 dark:text-emerald-400">{day.wins}</td>
      <td className="p-2.5 text-right tabular text-sm text-rose-600 dark:text-rose-400">{day.losses}</td>
      <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">{fmtWr(day.winRate)}</td>
      <td className={cn("p-2.5 text-right tabular text-sm font-semibold", win ? "text-emerald-600 dark:text-emerald-400" : loss ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-fg-muted)]")}>
        {fmtInr(day.realisedPnl)}
      </td>
      <td className={cn("p-2.5 text-right tabular text-[11px]", pnlClass(day.realisedPnlPct))}>
        {day.realisedPnlPct !== 0 ? `${day.realisedPnlPct >= 0 ? "+" : ""}${day.realisedPnlPct.toFixed(2)}%` : "—"}
      </td>
      <td className="p-2.5 text-right tabular text-[11px] text-[var(--color-fg-muted)]">
        {day.avgTradePct != null ? `${day.avgTradePct >= 0 ? "+" : ""}${day.avgTradePct.toFixed(2)}%` : "—"}
      </td>
      <td className="p-2.5 text-right tabular text-[11px]">
        <span className={cn(day.finalised ? "text-[var(--color-fg-subtle)]" : "text-amber-600 dark:text-amber-400 font-medium")}>
          {day.finalised ? "✓" : "Live"}
        </span>
      </td>
    </tr>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export function AutoTradingDashboard() {
  const [range,   setRange]   = React.useState<AnalyticsRange>("30d");
  const [data,    setData]    = React.useState<AutoTradingAnalytics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error,   setError]   = React.useState<string | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/in/paper-trade/analytics?range=${range}`, {
        cache: "no-store", signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as AutoTradingAnalytics);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally { setLoading(false); }
  }, [range]);

  React.useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const noData = !loading && data != null && data.totalDays === 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Header + range selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[color-mix(in_oklch,var(--color-brand)_15%,transparent)]">
            <Brain className="h-4 w-4 text-[var(--color-brand)]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Auto Trading Engine</h2>
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Intelligent signal scoring · ₹1L daily budget · top-5 trades
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {RANGES.map((r) => (
            <button key={r.id} onClick={() => setRange(r.id)}
              className={cn("rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                range === r.id
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              )}>
              {r.label}
            </button>
          ))}
          <button onClick={() => void load()} disabled={loading}
            className={cn("ml-1 inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]", loading && "opacity-60")}>
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-[12px] text-rose-500">{error}</div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-16 text-[12px] text-[var(--color-fg-muted)]">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading analytics…
        </div>
      ) : noData ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 py-10 text-center">
          <Brain className="mx-auto mb-3 h-8 w-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">No auto-trades yet for this period</p>
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            The engine scores every signal from Daily Picks and AI Signals and opens
            the top-ranked trades automatically. It starts fresh with ₹1,00,000 every
            session and never carries positions overnight.
          </p>
          <p className="mt-2 text-[11px] text-[var(--color-fg-subtle)]">
            Make sure the worker is running: <code className="font-mono">npm run worker:dev</code>
          </p>
        </div>
      ) : data ? (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <StatTile label="Trading days" value={String(data.totalDays)} icon={Calendar} />
            <StatTile
              label="Total trades" value={String(data.totalTrades)}
              sub={`${data.totalWins}W · ${data.totalLosses}L · ${data.totalExpired} exp`}
            />
            <StatTile
              label="Win rate" value={fmtWr(data.overallWinRate)}
              tone={data.overallWinRate != null ? (data.overallWinRate >= 0.5 ? "bull" : "bear") : "neutral"}
            />
            <StatTile
              label="Total P&L" value={fmtInr(data.totalPnl)}
              sub={data.totalPnlPct !== 0 ? `${data.totalPnlPct >= 0 ? "+" : ""}${data.totalPnlPct.toFixed(2)}% of budget` : "flat"}
              tone={data.totalPnl > 0 ? "bull" : data.totalPnl < 0 ? "bear" : "neutral"}
              icon={data.totalPnl >= 0 ? TrendingUp : TrendingDown}
            />
            <StatTile
              label="Avg daily P&L" value={fmtInr(data.avgDailyPnl)}
              sub={`${data.avgDailyPnlPct >= 0 ? "+" : ""}${data.avgDailyPnlPct.toFixed(2)}%/day`}
              tone={data.avgDailyPnl > 0 ? "bull" : data.avgDailyPnl < 0 ? "bear" : "neutral"}
            />
            <StatTile
              label="Consistency" value={`${data.consistency.toFixed(0)}%`}
              sub={`${data.profitDays}P · ${data.lossDays}L · ${data.breakEvenDays}BE`}
              tone={data.consistency >= 60 ? "bull" : data.consistency >= 40 ? "neutral" : "bear"}
              icon={Activity}
            />
          </div>

          {/* Row 2: more stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="Best day" value={fmtInr(data.bestDay?.realisedPnl ?? null)}
              sub={data.bestDay?.tradeDate} tone="bull"
            />
            <StatTile
              label="Worst day" value={fmtInr(data.worstDay?.realisedPnl ?? null)}
              sub={data.worstDay?.tradeDate} tone="bear"
            />
            <StatTile
              label="Max drawdown"
              value={data.maxDrawdownPct != null ? `-${data.maxDrawdownPct.toFixed(2)}%` : "—"}
              tone="bear" icon={TrendingDown}
            />
            <StatTile
              label="Sharpe ratio"
              value={data.sharpeRatio != null ? data.sharpeRatio.toFixed(2) : "—"}
              sub="annualised"
              tone={data.sharpeRatio != null ? (data.sharpeRatio >= 1 ? "bull" : data.sharpeRatio >= 0 ? "neutral" : "bear") : "neutral"}
              icon={BarChart3}
            />
          </div>

          {/* Equity curve */}
          {data.equityCurve.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)]">
                Cumulative P&L curve
              </p>
              <EquityCurve data={data.equityCurve} />
            </div>
          )}

          {/* Per-day breakdown */}
          {data.days.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)]">
                Daily breakdown
              </p>
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--color-bg-elevated)] text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                    <tr className="border-b border-[var(--color-border)]/60">
                      <th className="p-2.5 text-left font-medium">Date</th>
                      <th className="p-2.5 text-right font-medium">Trades</th>
                      <th className="p-2.5 text-right font-medium text-emerald-600 dark:text-emerald-400">Win</th>
                      <th className="p-2.5 text-right font-medium text-rose-600 dark:text-rose-400">Loss</th>
                      <th className="p-2.5 text-right font-medium">Win%</th>
                      <th className="p-2.5 text-right font-medium">Net P&amp;L</th>
                      <th className="p-2.5 text-right font-medium">P&amp;L%</th>
                      <th className="p-2.5 text-right font-medium">Avg/trade</th>
                      <th className="p-2.5 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.days].reverse().map((day) => (
                      <DayRow key={day.tradeDate} day={day} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Scoring methodology note */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-[11px] text-[var(--color-fg-muted)]">
            <span className="font-semibold text-[var(--color-fg)]">How signals are scored: </span>
            Composite score = 35% confidence + 25% win-probability + 25% grade (S/A/B/C/D) + 15% R:R (capped at 3:1).
            Only signals scoring ≥ 0.52 are considered. At most 5 positions open simultaneously, ₹20,000 notional each.
            Risk gate: stop distance must be ≤ 2.5% of entry. No new entries after 14:45 IST.
            All positions are closed at 15:30 IST — no overnight carry.
          </div>
        </>
      ) : null}
    </div>
  );
}
