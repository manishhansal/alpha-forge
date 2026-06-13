import "server-only";

import { runBacktest } from "@/features/strategy-lab/engine";
import { parseStrategy } from "@/features/strategy-lab/parser";
import {
  PERIOD_DURATION_MS,
  PERIOD_INTERVAL,
  type BacktestResult,
  type ParsedStrategy,
  type StrategyPeriod,
} from "@/features/strategy-lab/types";
import { getServerBroker } from "@/services/brokers/registry";
import type { KlineInterval } from "@/services/binance/klines";
import type { SymbolId } from "@/types/market";

/**
 * Resolve the kline interval the backtester will use for a given period.
 * Exposed so the parser knows the bar size when interpreting phrases like
 * "drops 5% in 4 hours".
 */
const INTERVAL_MINUTES: Record<KlineInterval, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "6h": 360,
  "8h": 480,
  "12h": 720,
  "1d": 1440,
};

export interface RunStrategyInput {
  prompt: string;
  symbol: SymbolId;
  period: StrategyPeriod;
}

export interface RunStrategyOutput extends BacktestResult {
  parsed: ParsedStrategy;
  fetchedBars: number;
}

/**
 * Fetch historical candles for `symbol` covering `period`, parse the prompt
 * with the matching bar interval (so duration phrases resolve correctly),
 * then execute the backtest.
 *
 * Returns a fully-formed `BacktestResult` plus the parsed strategy — the
 * UI shows the warnings/summary even when the engine returned zero trades.
 */
export async function runStrategy(input: RunStrategyInput): Promise<RunStrategyOutput> {
  const interval = PERIOD_INTERVAL[input.period];
  const intervalMinutes = INTERVAL_MINUTES[interval] ?? 60;
  const parsed = parseStrategy(input.prompt, { intervalMinutes });

  const broker = getServerBroker();
  const pair = broker.pairs.spot[input.symbol];
  if (!pair) {
    return {
      stats: emptyStats(input),
      equityCurve: [],
      trades: [],
      parsed,
      fetchedBars: 0,
    };
  }

  const endMs = Date.now();
  const startMs = endMs - PERIOD_DURATION_MS[input.period];

  let candles;
  try {
    candles = await broker.fetchKlinesRange(pair, interval, startMs, endMs);
  } catch (err) {
    parsed.warnings.push(`Could not load ${pair} ${interval} candles: ${(err as Error).message}.`);
    return {
      stats: emptyStats(input),
      equityCurve: [],
      trades: [],
      parsed,
      fetchedBars: 0,
    };
  }

  if (candles.length === 0) {
    parsed.warnings.push(`No historical candles returned for ${pair} ${interval}.`);
    return {
      stats: emptyStats(input),
      equityCurve: [],
      trades: [],
      parsed,
      fetchedBars: 0,
    };
  }

  // Drop the in-progress bar so the entry signal isn't fired on an unclosed
  // candle.
  const closed = candles.length > 1 ? candles.slice(0, -1) : candles;

  const result = runBacktest({
    symbol: input.symbol,
    period: input.period,
    interval,
    candles: closed,
    parsed,
  });

  return { ...result, fetchedBars: closed.length, parsed };
}

function emptyStats(input: RunStrategyInput) {
  return {
    symbol: input.symbol,
    period: input.period,
    interval: PERIOD_INTERVAL[input.period],
    startTs: 0,
    endTs: 0,
    startEquity: 1000,
    endEquity: 1000,
    totalReturnPct: 0,
    buyHoldReturnPct: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    largestWinPct: 0,
    largestLossPct: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    avgBarsHeld: 0,
    totalPnlUsd: 0,
  };
}
