"use client";

import { RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { ScalperBacktestSummary } from "@/features/scalping/backtest-summary-types";
import { useStrategyBacktest } from "@/components/scalper/strategy-backtest-context";
import { StrategyScoreBadge } from "@/components/scalper/strategy-score-badge";
import { EquitySparkline } from "@/components/strategy-lab/equity-sparkline";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SCALP_STRATEGY_META } from "@/features/scalping/strategies/catalog";
import type { BacktestInterval } from "@/features/scalping/backtest-intervals";
import { cn, formatUsd } from "@/lib/utils";
import type { SymbolId } from "@/types/market";

type SymbolOption = "ALL" | SymbolId;

const SYMBOLS: SymbolId[] = ["BTC", "ETH", "SOL"];

/**
 * Full Strategy Backtest dashboard.
 *
 * Lists every scalping strategy with a 5-year backtest summary on $10,000
 * starting equity. Users can flip the active symbol (BTC / ETH / SOL or
 * the aggregate "ALL") to see how each strategy held up market-by-market,
 * and the leaderboard sorts strategies by their 0-100 score so the
 * recommendation flow is immediate.
 */
export function StrategyBacktestPanel() {
  const { data, loading, error, refresh, interval, intervalOptions, setInterval } =
    useStrategyBacktest();
  const [symbol, setSymbol] = useState<SymbolOption>("ALL");

  // First-load (no cached data for any interval) — keep the existing
  // immersive loading state so the user understands the cold-start cost.
  if (loading && !data) {
    return (
      <div className="flex flex-col gap-5">
        <IntervalToggle
          value={interval}
          options={intervalOptions}
          onChange={setInterval}
          disabled
        />
        <LoadingState interval={interval} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="flex flex-col gap-5">
        <IntervalToggle
          value={interval}
          options={intervalOptions}
          onChange={setInterval}
        />
        <ErrorState message={error} onRetry={() => refresh({ force: true })} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-5">
      <OverviewCard data={data} onRefresh={() => refresh({ force: true })} loading={loading} />
      <IntervalToggle
        value={interval}
        options={intervalOptions}
        onChange={setInterval}
        loading={loading}
      />
      <SymbolToggle value={symbol} onChange={setSymbol} />
      <StrategyLeaderboard data={data} symbol={symbol} />
    </div>
  );
}

const INTERVAL_LABEL: Record<BacktestInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "10m": "10m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

function IntervalToggle({
  value,
  options,
  onChange,
  loading,
  disabled,
}: {
  value: BacktestInterval;
  options: ReadonlyArray<BacktestInterval>;
  onChange: (next: BacktestInterval) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        Timeframe
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              disabled={disabled || (loading && active)}
              aria-pressed={active}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-tight tabular-nums transition-colors",
                active
                  ? "border-[color-mix(in_oklch,var(--color-info)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]",
                (disabled || (loading && active)) && "cursor-not-allowed opacity-60",
              )}
            >
              {INTERVAL_LABEL[opt]}
              {loading && active ? (
                <RefreshCw className="ml-1 inline-block h-2.5 w-2.5 animate-spin" />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LoadingState({ interval }: { interval: BacktestInterval }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3 py-6">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg-muted)]">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--color-info)]" />
            Running {INTERVAL_LABEL[interval]} backtest for every strategy
            across BTC / ETH / SOL…
          </div>
          <p className="text-[11px] text-[var(--color-fg-subtle)]">
            First run for a timeframe can take 10-30 seconds while we fetch
            historical candles per symbol and replay each strategy bar-by-bar.
            Results are cached per timeframe for 24 hours so reloads (and
            toggling back to an already-loaded timeframe) are instant.
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[180px] w-full rounded-xl" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-6">
        <p className="text-[12px] font-semibold text-[var(--color-bear)]">
          Backtest failed to load
        </p>
        <p className="text-[11px] text-[var(--color-fg-muted)]">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-fg)] hover:border-[color-mix(in_oklch,var(--color-info)_45%,transparent)]"
        >
          Try again
        </button>
      </CardContent>
    </Card>
  );
}

function OverviewCard({
  data,
  onRefresh,
  loading,
}: {
  data: ScalperBacktestSummary;
  onRefresh: () => void;
  loading: boolean;
}) {
  const totals = useMemo(() => {
    const trades = data.reports.reduce((s, r) => s + r.aggregate.totalTrades, 0);
    const pnl = data.reports.reduce((s, r) => s + r.aggregate.totalPnlUsd, 0);
    const avgScore =
      data.reports.length > 0
        ? data.reports.reduce((s, r) => s + r.score.score, 0) / data.reports.length
        : 0;
    const topReport = [...data.reports].sort((a, b) => b.score.score - a.score.score)[0];
    return { trades, pnl, avgScore, topReport };
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Strategy backtest · {data.periodLabel} · ${data.startEquity.toLocaleString()} starting equity
          </CardTitle>
          <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
            {data.symbols.join(" · ")} · {data.interval} bars · $
            {data.notional.toLocaleString()} per trade ·{" "}
            <CandleSourceLabel data={data} /> · generated{" "}
            {new Date(data.generatedAt).toLocaleString()}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]",
            loading && "opacity-50",
          )}
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          Recompute
        </button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Strategies"
            value={data.reports.length.toString()}
            hint="evaluated in parallel"
          />
          <Stat
            label="Total trades"
            value={totals.trades.toLocaleString()}
            hint="across all symbols + strategies"
          />
          <Stat
            label="Net P&L"
            value={`${totals.pnl >= 0 ? "+" : ""}${formatUsd(totals.pnl)}`}
            hint={`on $${(data.startEquity * data.symbols.length * data.reports.length).toLocaleString()} aggregate`}
            valueClass={totals.pnl >= 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"}
          />
          <Stat
            label="Average score"
            value={`${totals.avgScore.toFixed(0)}/100`}
            hint={
              totals.topReport
                ? `best: ${SCALP_STRATEGY_META[totals.topReport.strategyId].label} (${totals.topReport.score.score})`
                : "—"
            }
            valueClass={
              totals.avgScore >= 60
                ? "text-[var(--color-bull)]"
                : totals.avgScore < 40
                  ? "text-[var(--color-bear)]"
                  : undefined
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SymbolToggle({
  value,
  onChange,
}: {
  value: SymbolOption;
  onChange: (v: SymbolOption) => void;
}) {
  const options: SymbolOption[] = ["ALL", ...SYMBOLS];
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        Symbol
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              aria-pressed={active}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-tight transition-colors",
                active
                  ? "border-[color-mix(in_oklch,var(--color-info)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]",
              )}
            >
              {opt === "ALL" ? "All symbols" : opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StrategyLeaderboard({
  data,
  symbol,
}: {
  data: ScalperBacktestSummary;
  symbol: SymbolOption;
}) {
  const ranked = useMemo(
    () => [...data.reports].sort((a, b) => b.score.score - a.score.score),
    [data],
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {ranked.map((report, idx) => (
        <StrategyCard
          key={report.strategyId}
          rank={idx + 1}
          report={report}
          symbol={symbol}
        />
      ))}
    </div>
  );
}

function StrategyCard({
  rank,
  report,
  symbol,
}: {
  rank: number;
  report: ScalperBacktestSummary["reports"][number];
  symbol: SymbolOption;
}) {
  const meta = SCALP_STRATEGY_META[report.strategyId];
  const selected = useMemo(() => {
    if (symbol === "ALL") {
      return {
        stats: report.aggregate,
        equityCurve: aggregateCurve(report.perSymbol.map((p) => p.equityCurve)),
        tradeCount: report.aggregate.totalTrades,
      };
    }
    const row = report.perSymbol.find((p) => p.symbol === symbol);
    return row
      ? { stats: row.stats, equityCurve: row.equityCurve, tradeCount: row.tradeCount }
      : null;
  }, [report, symbol]);

  if (!selected) {
    return (
      <Card>
        <CardContent className="py-4 text-[11px] text-[var(--color-fg-muted)]">
          No backtest data for {symbol}.
        </CardContent>
      </Card>
    );
  }
  const { stats, equityCurve, tradeCount } = selected;
  const positive = stats.totalReturnPct >= 0;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-bg-elevated)] text-[11px] font-bold text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]">
              #{rank}
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-[13px] font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                {meta.label}
              </CardTitle>
              <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                {meta.category}
                {symbol === "ALL" ? " · aggregate" : ` · ${symbol}`}
              </span>
            </div>
          </div>
          <StrategyScoreBadge score={report.score} />
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          {report.score.rationale}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniStat
            label="Net P&L"
            value={`${stats.totalPnlUsd >= 0 ? "+" : ""}${formatUsd(stats.totalPnlUsd)}`}
            valueClass={
              stats.totalPnlUsd > 0
                ? "text-[var(--color-bull)]"
                : stats.totalPnlUsd < 0
                  ? "text-[var(--color-bear)]"
                  : undefined
            }
          />
          <MiniStat
            label="Win rate"
            value={`${(stats.winRate * 100).toFixed(0)}%`}
            hint={`${stats.wins}W / ${stats.losses}L`}
            valueClass={
              stats.winRate >= 0.5 ? "text-[var(--color-bull)]" : undefined
            }
          />
          <MiniStat
            label="Profit factor"
            value={formatPf(stats.profitFactor)}
            hint={`avg win ${signedPct(stats.avgWinPct)}`}
          />
          <MiniStat
            label="Max DD"
            value={`${(stats.maxDrawdownPct * 100).toFixed(1)}%`}
            valueClass="text-[var(--color-bear)]"
          />
          <MiniStat
            label="Total return"
            value={signedPct(stats.totalReturnPct)}
            hint={`B&H ${signedPct(stats.buyHoldReturnPct)}`}
            valueClass={positive ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"}
          />
          <MiniStat label="Sharpe" value={stats.sharpe.toFixed(2)} hint="annualised" />
          <MiniStat label="Trades" value={tradeCount.toLocaleString()} />
          <MiniStat
            label="Avg hold"
            value={`${Math.round(stats.avgBarsHeld)}b`}
            hint={stats.expired > 0 ? `${stats.expired} expired` : "—"}
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            <span>Equity curve</span>
            <Badge variant={positive ? "bull" : "bear"} className="px-1.5 py-0">
              {positive ? (
                <TrendingUp className="h-2.5 w-2.5" />
              ) : (
                <TrendingDown className="h-2.5 w-2.5" />
              )}
              {signedPct(stats.totalReturnPct)}
            </Badge>
          </div>
          <EquitySparkline curve={equityCurve} height={90} />
        </div>
      </CardContent>
    </Card>
  );
}

function CandleSourceLabel({ data }: { data: ScalperBacktestSummary }) {
  const total = data.candleMeta.reduce((s, m) => s + m.bars, 0);
  let label: string;
  switch (data.candleSource) {
    case "binance-fallback":
      label = "Binance historical data";
      break;
    case "active-broker":
      label = "live broker history";
      break;
    case "mixed":
      label = "mixed sources (active broker + Binance)";
      break;
    case "none":
      label = "no candle source";
      break;
  }
  return (
    <span
      title={data.candleMeta
        .map((m) => `${m.symbol}: ${m.bars.toLocaleString()} bars from ${humanSource(m.source)}`)
        .join("  |  ")}
      className="cursor-help underline decoration-dotted underline-offset-2"
    >
      {label} · {total.toLocaleString()} bars
    </span>
  );
}

function humanSource(s: "active-broker" | "binance-fallback" | "none"): string {
  if (s === "binance-fallback") return "Binance";
  if (s === "active-broker") return "active broker";
  return "n/a";
}

function MiniStat({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className={cn("mt-0.5 text-[12px] font-semibold tracking-tight tabular-nums", valueClass)}>
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 truncate text-[9px] text-[var(--color-fg-subtle)]">{hint}</p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className={cn("mt-1 text-lg font-semibold tracking-tight tabular-nums", valueClass)}>
        {value}
      </p>
      {hint ? <p className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</p> : null}
    </div>
  );
}

function signedPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatPf(pf: number): string {
  if (!Number.isFinite(pf)) return "∞";
  if (pf === 0) return "—";
  return pf.toFixed(2);
}

/**
 * Sum per-symbol equity curves into a single curve on a shared time axis.
 * The points aren't aligned bar-for-bar (each symbol's run starts after its
 * own warm-up window), but the trend across the full 5-year window is the
 * useful thing to look at — we sort the union of timestamps, forward-fill
 * each symbol, and sum the equities.
 */
function aggregateCurve(
  curves: Array<{ ts: number; equity: number }[]>,
): Array<{ ts: number; equity: number }> {
  if (curves.length === 0) return [];
  const timestamps = new Set<number>();
  for (const c of curves) for (const p of c) timestamps.add(p.ts);
  const sorted = [...timestamps].sort((a, b) => a - b);
  const cursors = curves.map(() => 0);
  const lastVals = curves.map((c) => (c.length > 0 ? c[0].equity : 0));
  const out: Array<{ ts: number; equity: number }> = [];
  for (const ts of sorted) {
    let total = 0;
    for (let i = 0; i < curves.length; i += 1) {
      const c = curves[i];
      while (cursors[i] < c.length && c[cursors[i]].ts <= ts) {
        lastVals[i] = c[cursors[i]].equity;
        cursors[i] += 1;
      }
      total += lastVals[i];
    }
    out.push({ ts, equity: total });
  }
  return out;
}
