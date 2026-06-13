"use client";

import * as React from "react";
import Link from "next/link";
import { Beaker, BookCheck, Calendar, Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IndiaFeaturePreview } from "@/components/india/common/india-feature-preview";
import { Button } from "@/components/india/ui/button";
import { FNO_INDICES, FNO_STOCKS } from "@/lib/india/fno-symbols";
import { fmt } from "@/lib/india/format";
import type { Candle, Interval } from "@/types/india";

type HistoricalResponse = {
  symbol: string;
  interval: Interval;
  range: string;
  candles: Candle[];
  source: string;
};

const INTERVAL_OPTIONS: { id: Interval; label: string; range: string }[] = [
  { id: "5m", label: "5m", range: "1mo" },
  { id: "15m", label: "15m", range: "3mo" },
  { id: "1h", label: "1h", range: "1y" },
  { id: "1d", label: "1d", range: "5y" },
  { id: "1w", label: "1w", range: "5y" },
];

const TOP_STOCKS = ["RELIANCE", "HDFCBANK", "ICICIBANK", "TCS", "INFY", "SBIN"];

export function IndiaBacktestPreview() {
  const [symbol, setSymbol] = React.useState<string>("NIFTY");
  const [interval, setInterval] = React.useState<Interval>("1d");
  const [data, setData] = React.useState<HistoricalResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Resolve UI symbol -> Yahoo ticker the historical route accepts.
  const resolvedSymbol = React.useMemo(() => {
    const idx = FNO_INDICES.find((i) => i.underlying === symbol);
    return idx ? idx.symbol : symbol;
  }, [symbol]);

  const range = React.useMemo(
    () => INTERVAL_OPTIONS.find((i) => i.id === interval)?.range ?? "6mo",
    [interval],
  );

  React.useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/in/historical?symbol=${encodeURIComponent(
          resolvedSymbol,
        )}&interval=${interval}&range=${range}`;
        const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as HistoricalResponse;
        if (!cancelled) setData(json);
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [resolvedSymbol, interval, range]);

  const stats = React.useMemo(() => computeStats(data?.candles ?? []), [data]);

  return (
    <IndiaFeaturePreview
      state="planned"
      pillLabel="NIFTY · BANKNIFTY · F&O stocks"
      liveSummary={
        <>
          The crypto Strategy Backtest replays five years of 4h klines for ten
          strategies on BTC / ETH / SOL with $10,000 starting equity, then
          assigns a 0–100 score and a letter grade per strategy. The historical
          fetcher and grading engine work — what we&apos;re still wiring up is
          re-targeting the strategy modules to NSE-specific signals
          (gap behaviour, ATM IV, OI delta on weekly options). Until then,
          this scaffold lets you sanity-check the historical OHLCV the engine
          will train against.
        </>
      }
      liveBullets={[
        "Live historical OHLCV fetch via the active broker adapter (Yahoo / NSE / Groww)",
        "Picker for indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) + top F&O stocks",
        "Multi-timeframe windows (5m / 15m / 1h / 1d / 1w) — same intervals the engine will replay",
        "Quick OHLCV stats (lookback, avg ATR-as-percentage, avg daily move, candle count)",
      ]}
      roadmap={[
        {
          title: "Retarget strategy modules for F&O",
          detail:
            "The 10 crypto strategies (UT Bot+SMC, VWAP Sweep, News Momentum, Range Scalp, EMA Pullback, VWAP Reversion, Orderflow Sweep, Fib Pullback, Institutional SMC, AI Pro v5) get NSE-aware signal logic — gap-handling, ATM IV regime filter, expiry-day cooldown.",
        },
        {
          title: "ATR-sized stop / target on equity tick size",
          detail:
            "Trade simulator respects NSE tick-size (₹0.05) and rounds stops to it; per-trade notional configurable per underlying (₹50k for stocks, ₹1L for indices).",
        },
        {
          title: "Score + grade per strategy on F&O",
          detail:
            "Existing scoring engine (win-rate 25 / profit-factor 20 / alpha 20 / drawdown 15 / Sharpe 10 / trade-count 10) is broker-agnostic — once the strategies emit signals, scoring drops in unchanged.",
        },
        {
          title: "Aggregate cross-symbol view + sparklines",
          detail:
            "Same leaderboard layout as crypto: per-strategy card with equity-curve sparkline, plus an All-Symbols aggregate.",
        },
      ]}
      links={[
        { href: "/strategy-backtest", label: "See crypto strategy backtest →" },
      ]}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            <span className="inline-flex items-center gap-2">
              <Beaker className="h-4 w-4 text-[var(--color-brand)]" />
              Historical fetch — exactly what the engine will replay
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Underlying
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {FNO_INDICES.map((i) => (
                  <Chip
                    key={i.underlying}
                    active={symbol === i.underlying}
                    onClick={() => setSymbol(i.underlying)}
                  >
                    {i.underlying}
                  </Chip>
                ))}
                <span className="mx-1 text-[var(--color-fg-subtle)]">·</span>
                {TOP_STOCKS.filter((s) => FNO_STOCKS.includes(s)).map((s) => (
                  <Chip
                    key={s}
                    active={symbol === s}
                    onClick={() => setSymbol(s)}
                  >
                    {s}
                  </Chip>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Timeframe · lookback
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {INTERVAL_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.id}
                    active={interval === opt.id}
                    onClick={() => setInterval(opt.id)}
                  >
                    {opt.label}
                    <span className="ml-1 text-[10px] text-[var(--color-fg-subtle)]">
                      {opt.range}
                    </span>
                  </Chip>
                ))}
              </div>
            </div>

            <div className="grid gap-2 pt-2 sm:grid-cols-4">
              <Stat label="Symbol" value={data?.symbol ?? resolvedSymbol} />
              <Stat label="Source" value={data?.source ?? "—"} />
              <Stat label="Bars" value={String(data?.candles.length ?? 0)} />
              <Stat label="Range" value={data?.range ?? range} />
            </div>

            <div className="grid gap-2 sm:grid-cols-4">
              <Stat label="Avg daily %" value={fmt(stats.avgDailyPct, 2) + "%"} />
              <Stat label="ATR / Close %" value={fmt(stats.atrPct, 2) + "%"} />
              <Stat label="Hi" value={fmt(stats.high)} />
              <Stat label="Lo" value={fmt(stats.low)} />
            </div>

            {error && (
              <div className="rounded-lg border border-[var(--color-bear)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] p-2 text-[12px] text-[var(--color-bear)]">
                {error}
              </div>
            )}
            {loading && (
              <div className="text-[12px] text-[var(--color-fg-muted)]">
                Loading historical bars…
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Link
                href={`/in/chart/${encodeURIComponent(symbol === resolvedSymbol ? symbol : symbol)}`}
              >
                <Button size="sm" variant="outline">
                  <Sparkles className="h-3 w-3 mr-1" />
                  View on chart
                </Button>
              </Link>
              <a
                href={`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button size="sm" variant="outline">
                  <BookCheck className="h-3 w-3 mr-1" />
                  TradingView
                </Button>
              </a>
              {interval === "1d" && (
                <Badge variant="info">
                  <Calendar className="h-3 w-3" />
                  5y daily — same window the crypto engine uses
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </IndiaFeaturePreview>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ring-1 ring-inset ${
        active
          ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-[var(--color-border-strong)]"
          : "bg-transparent text-[var(--color-fg-muted)] ring-[var(--color-border)] hover:text-[var(--color-fg)]"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular">{value}</div>
    </div>
  );
}

function computeStats(candles: Candle[]): {
  avgDailyPct: number | null;
  atrPct: number | null;
  high: number | null;
  low: number | null;
} {
  if (candles.length < 2)
    return { avgDailyPct: null, atrPct: null, high: null, low: null };

  let totalPct = 0;
  let totalRange = 0;
  let totalClose = 0;
  let high = -Infinity;
  let low = Infinity;
  let prev = candles[0].close;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    if (prev > 0) totalPct += Math.abs((c.close - prev) / prev) * 100;
    totalRange += c.high - c.low;
    totalClose += c.close;
    prev = c.close;
  }

  const n = candles.length;
  const avgClose = totalClose / n;
  return {
    avgDailyPct: totalPct / (n - 1),
    atrPct: avgClose > 0 ? (totalRange / n / avgClose) * 100 : null,
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
  };
}
