import { NextResponse } from "next/server";

import {
  BACKTEST_INTERVAL,
  BACKTEST_INTERVAL_CONFIG,
  BACKTEST_INTERVAL_DEFAULT,
  BACKTEST_INTERVAL_OPTIONS,
  BACKTEST_NOTIONAL,
  BACKTEST_PERIOD_YEARS,
  BACKTEST_START_EQUITY,
  BACKTEST_SYMBOLS,
  getStrategyBacktestSuite,
  type BacktestInterval,
} from "@/features/scalping/run-all-backtests";
import type { ScalperBacktestSummary } from "@/features/scalping/backtest-summary-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep the route alive long enough for the (cold-cache) first request to
// finish the suite — the heaviest bar size (4h × 5Y × 3 symbols × 9
// strategies) can take ~20-30 seconds when nothing is cached.
export const maxDuration = 60;

/**
 * GET /api/scalper/backtest[?detail=summary|full&interval=5m]
 *
 * Returns the multi-strategy backtest suite for every scalping strategy.
 * By default we return the compact "summary" shape (no trade log) so the
 * strategy picker can stay lightweight; pass `detail=full` to also get
 * every trade.
 *
 * The `interval` query param selects the bar size to run on. Supported
 * values: 1m, 5m, 10m, 15m, 1h, 4h, 1d (default: 4h, matching the
 * historical behavior of the strategy picker chips). Each interval ships
 * with its own adaptive lookback window so candle counts stay sane —
 * see `BACKTEST_INTERVAL_CONFIG` for the mapping.
 *
 * The first request after a server start can take ~20-30s while the suite
 * computes; subsequent requests for the same `(broker, interval)` are
 * instant thanks to the in-process cache (see `getStrategyBacktestSuite`).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const detail = url.searchParams.get("detail") === "full" ? "full" : "summary";
  const force = url.searchParams.get("force") === "1";
  const intervalParam = url.searchParams.get("interval");
  const interval: BacktestInterval =
    intervalParam &&
    (BACKTEST_INTERVAL_OPTIONS as readonly string[]).includes(intervalParam)
      ? (intervalParam as BacktestInterval)
      : BACKTEST_INTERVAL_DEFAULT;

  try {
    const suite = await getStrategyBacktestSuite({ force, interval });
    if (detail === "full") {
      return NextResponse.json(suite, {
        headers: {
          "Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
        },
      });
    }

    const summary: ScalperBacktestSummary = {
      generatedAt: suite.generatedAt,
      interval: suite.interval,
      periodLabel: suite.periodLabel,
      periodMs: suite.periodMs,
      periodYears: suite.periodYears,
      startEquity: suite.startEquity,
      notional: suite.notional,
      symbols: [...BACKTEST_SYMBOLS],
      candleSource: suite.candleSource,
      candleMeta: suite.candleMeta,
      reports: suite.reports.map((r) => ({
        strategyId: r.strategyId,
        score: r.score,
        aggregate: r.aggregate,
        perSymbol: r.perSymbol.map((p) => ({
          symbol: p.symbol,
          stats: p.stats,
          equityCurve: p.equityCurve,
          tradeCount: p.trades.length,
        })),
      })),
    };
    return NextResponse.json(summary, {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    console.error("[/api/scalper/backtest] error:", err);
    const config = BACKTEST_INTERVAL_CONFIG[interval];
    return NextResponse.json(
      {
        error: true,
        code: "BACKTEST_FAILED",
        message: (err as Error).message,
        meta: {
          interval,
          periodLabel: config.periodLabel,
          // Legacy fields, kept so older clients don't break.
          defaultInterval: BACKTEST_INTERVAL,
          periodYears: BACKTEST_PERIOD_YEARS,
          startEquity: BACKTEST_START_EQUITY,
          notional: BACKTEST_NOTIONAL,
        },
      },
      { status: 502 },
    );
  }
}
