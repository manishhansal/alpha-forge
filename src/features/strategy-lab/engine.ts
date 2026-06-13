import {
  atr as atrFinal,
  emaSeries,
  rsi as rsiFinal,
} from "@/features/signals/indicators";
import type {
  BacktestResult,
  BacktestStats,
  BacktestTrade,
  Condition,
  EquityPoint,
  IndicatorRef,
  Operand,
  ParsedStrategy,
  Rule,
  StrategyPeriod,
} from "@/features/strategy-lab/types";
import type { KlineCandle, SymbolId } from "@/types/market";

/**
 * Single-symbol backtester.
 *
 * Walks the candle stream once, materialises every indicator referenced by
 * the parsed strategy as a value-per-bar series, and then evaluates entry /
 * exit conditions bar-by-bar. Only one position is open at a time. Stops
 * and targets are checked intra-bar against high/low; ties resolve as a
 * stop (conservative — same convention as the scalper).
 *
 * Equity is tracked as a cumulative USD P&L on the configured notional. We
 * deliberately don't compound — each trade uses the same notional so win
 * rate, expectancy, and drawdown remain comparable across strategies of
 * vastly different return profiles.
 */
export interface BacktestInput {
  symbol: SymbolId;
  period: StrategyPeriod;
  interval: string;
  candles: KlineCandle[];
  parsed: ParsedStrategy;
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const { candles, parsed, symbol, period, interval } = input;
  const n = candles.length;
  if (n < 30) {
    return emptyResult(input);
  }

  const refs = collectRefs(parsed);
  const series = buildSeries(candles, refs);
  const closes = candles.map((c) => c.close);
  const atr14 = computeAtrSeries(candles, 14);

  const startEquity = parsed.notional;
  let equity = startEquity;
  const equityCurve: EquityPoint[] = [];
  const trades: BacktestTrade[] = [];

  type Position = {
    side: "LONG" | "SHORT";
    entry: number;
    stop: number;
    target: number;
    openedBar: number;
    openedAt: number;
  };
  let pos: Position | null = null;

  // Warm-up: skip the first ~50 bars so EMA/RSI/MACD have stabilised.
  const warmup = Math.min(60, Math.floor(n / 5));

  for (let i = warmup; i < n; i += 1) {
    const candle = candles[i];

    if (pos) {
      const isLong = pos.side === "LONG";
      let closed = false;
      let exitPrice = candle.close;
      let reason = "";

      // Intra-bar SL/TP — tie resolves as stop.
      const hitStop = isLong ? candle.low <= pos.stop : candle.high >= pos.stop;
      const hitTarget = isLong ? candle.high >= pos.target : candle.low <= pos.target;
      if (hitStop) {
        exitPrice = pos.stop;
        reason = "STOP";
        closed = true;
      } else if (hitTarget) {
        exitPrice = pos.target;
        reason = "TARGET";
        closed = true;
      }

      // Exit rule (close-on-bar).
      if (!closed && parsed.exit && evaluateRule(parsed.exit, series, i, candles)) {
        exitPrice = candle.close;
        reason = "EXIT_RULE";
        closed = true;
      }

      // Max hold.
      if (!closed && parsed.risk.maxHoldBars && i - pos.openedBar >= parsed.risk.maxHoldBars) {
        exitPrice = candle.close;
        reason = "MAX_HOLD";
        closed = true;
      }

      // Hit end-of-data: force-close on the last bar so equity reflects the
      // open MTM rather than the trade lingering.
      if (!closed && i === n - 1) {
        exitPrice = candle.close;
        reason = "EOD";
        closed = true;
      }

      if (closed) {
        const raw = (exitPrice - pos.entry) / pos.entry;
        const pnlPct = (isLong ? raw : -raw) * 100;
        const pnlUsd = (pnlPct / 100) * parsed.notional;
        equity += pnlUsd;
        trades.push({
          side: pos.side,
          entry: pos.entry,
          exit: exitPrice,
          reason,
          openedAt: pos.openedAt,
          closedAt: candle.closeTime,
          pnlPct,
          pnlUsd,
          bars: i - pos.openedBar,
        });
        pos = null;
      }
    }

    // Entry — only if flat. We re-check after a possible exit on the same
    // bar so a "stop hit then re-enter" sequence is allowed.
    if (!pos && evaluateRule(parsed.entry, series, i, candles)) {
      const close = candle.close;
      const isLong = parsed.side === "LONG";
      const atrVal = atr14[i];
      const stopDist = computeStopDist(parsed, close, atrVal);
      const targetDist = computeTargetDist(parsed, close, atrVal);
      const stop = isLong ? close - stopDist : close + stopDist;
      const target = isLong ? close + targetDist : close - targetDist;
      pos = {
        side: parsed.side,
        entry: close,
        stop,
        target,
        openedBar: i,
        openedAt: candle.closeTime,
      };
    }

    equityCurve.push({ ts: candle.closeTime, equity });
  }

  // Down-sample equity curve to ≤ 200 points so the JSON column stays light.
  const sampledCurve = downsample(equityCurve, 200);

  const stats = computeStats({
    symbol,
    period,
    interval,
    startEquity,
    endEquity: equity,
    candles,
    closes,
    trades,
    parsed,
    equityCurve,
  });

  return {
    stats,
    equityCurve: sampledCurve,
    trades,
    parsed,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Indicator series materialisation.
// ───────────────────────────────────────────────────────────────────────────
type SeriesMap = Map<string, number[]>;

function refKey(ref: IndicatorRef): string {
  return `${ref.kind}:${ref.period ?? 0}:${ref.lookback ?? 0}`;
}

function collectRefs(parsed: ParsedStrategy): IndicatorRef[] {
  const out = new Map<string, IndicatorRef>();
  const visit = (rule: Rule | null) => {
    if (!rule) return;
    for (const c of rule.conditions) {
      for (const o of [c.left, c.right]) {
        if (o.kind === "INDICATOR") out.set(refKey(o.ref), o.ref);
      }
    }
  };
  visit(parsed.entry);
  visit(parsed.exit);
  return Array.from(out.values());
}

function buildSeries(candles: KlineCandle[], refs: IndicatorRef[]): SeriesMap {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const out: SeriesMap = new Map();

  // Always make CLOSE / PRICE / VOLUME available even if no condition refs them.
  out.set(refKey({ kind: "CLOSE" }), closes);
  out.set(refKey({ kind: "PRICE" }), closes);
  out.set(refKey({ kind: "VOLUME" }), volumes);

  for (const ref of refs) {
    const key = refKey(ref);
    if (out.has(key)) continue;
    switch (ref.kind) {
      case "RSI": {
        out.set(key, rsiSeries(closes, ref.period ?? 14));
        break;
      }
      case "EMA": {
        out.set(key, emaSeries(closes, ref.period ?? 20));
        break;
      }
      case "SMA": {
        out.set(key, smaSeries(closes, ref.period ?? 50));
        break;
      }
      case "ATR": {
        out.set(key, computeAtrSeries(candles, ref.period ?? 14));
        break;
      }
      case "MACD_LINE":
      case "MACD_SIGNAL":
      case "MACD_HIST": {
        const fast = emaSeries(closes, 12);
        const slow = emaSeries(closes, 26);
        const line = closes.map((_, i) => fast[i] - slow[i]);
        const sig = emaSeries(line, 9);
        out.set(refKey({ kind: "MACD_LINE" }), line);
        out.set(refKey({ kind: "MACD_SIGNAL" }), sig);
        out.set(
          refKey({ kind: "MACD_HIST" }),
          line.map((v, i) => v - sig[i]),
        );
        break;
      }
      case "VOLUME_AVG": {
        out.set(key, smaSeries(volumes, ref.period ?? 20));
        break;
      }
      case "PCT_CHANGE": {
        const lookback = Math.max(1, ref.lookback ?? 1);
        const series = closes.map((c, i) => {
          const prev = closes[Math.max(0, i - lookback)];
          if (!prev || prev === 0) return 0;
          return (c - prev) / prev;
        });
        out.set(key, series);
        break;
      }
      case "VOLUME":
      case "PRICE":
      case "CLOSE":
        break;
    }
  }

  return out;
}

function rsiSeries(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(50);
  if (closes.length < period + 2) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    if (avgLoss === 0) out[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  // Forward-fill warm-up so cross detection doesn't trigger on the seed bar.
  for (let i = 0; i < period; i += 1) out[i] = out[period];
  return out;
}

function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  if (values.length === 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    const denom = Math.min(i + 1, period);
    out[i] = sum / denom;
  }
  return out;
}

function computeAtrSeries(candles: KlineCandle[], period: number): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;
  const trs: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs[i] = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  let prev = 0;
  if (n > period) {
    for (let i = 1; i <= period; i += 1) prev += trs[i];
    prev /= period;
    for (let i = 0; i <= period; i += 1) out[i] = prev;
    for (let i = period + 1; i < n; i += 1) {
      prev = (prev * (period - 1) + trs[i]) / period;
      out[i] = prev;
    }
  } else {
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      acc += trs[i];
      out[i] = acc / Math.max(i, 1);
    }
  }
  return out;
}

// Reference unused imports so tree-shaking doesn't strip them when something
// else later needs the standalone (single-value) versions.
void rsiFinal;
void atrFinal;
void emaSeries;

// ───────────────────────────────────────────────────────────────────────────
// Rule evaluation.
// ───────────────────────────────────────────────────────────────────────────
function evaluateRule(rule: Rule, series: SeriesMap, i: number, candles: KlineCandle[]): boolean {
  if (rule.conditions.length === 0) return false;
  if (rule.logic === "OR") {
    return rule.conditions.some((c) => evaluateCondition(c, series, i, candles));
  }
  return rule.conditions.every((c) => evaluateCondition(c, series, i, candles));
}

function evaluateCondition(
  c: Condition,
  series: SeriesMap,
  i: number,
  candles: KlineCandle[],
): boolean {
  const leftNow = operandValue(c.left, series, i, candles);
  const rightNow = operandValue(c.right, series, i, candles);
  if (!Number.isFinite(leftNow) || !Number.isFinite(rightNow)) return false;

  switch (c.comparator) {
    case ">":
      return leftNow > rightNow;
    case ">=":
      return leftNow >= rightNow;
    case "<":
      return leftNow < rightNow;
    case "<=":
      return leftNow <= rightNow;
    case "==":
      return Math.abs(leftNow - rightNow) < 1e-9;
    case "CROSS_ABOVE": {
      if (i === 0) return false;
      const leftPrev = operandValue(c.left, series, i - 1, candles);
      const rightPrev = operandValue(c.right, series, i - 1, candles);
      return leftPrev <= rightPrev && leftNow > rightNow;
    }
    case "CROSS_BELOW": {
      if (i === 0) return false;
      const leftPrev = operandValue(c.left, series, i - 1, candles);
      const rightPrev = operandValue(c.right, series, i - 1, candles);
      return leftPrev >= rightPrev && leftNow < rightNow;
    }
  }
}

function operandValue(o: Operand, series: SeriesMap, i: number, candles: KlineCandle[]): number {
  if (o.kind === "NUMBER") return o.value;
  const ref = o.ref;
  if (ref.kind === "VOLUME") {
    // Special case: when the user wrote "volume above 1.5x average", we
    // encode it as VOLUME > 1.5. To make that comparison make sense, we
    // emit volume *as a ratio against its 20-bar SMA* whenever the right
    // operand is a small number.
    const vol = candles[i].volume;
    const avgSeries = series.get(refKey({ kind: "VOLUME_AVG", period: 20 })) ?? smaSeries(
      candles.map((c) => c.volume),
      20,
    );
    const avg = avgSeries[i];
    return avg > 0 ? vol / avg : 0;
  }
  const arr = series.get(refKey(ref));
  if (!arr) return NaN;
  return arr[i];
}

// ───────────────────────────────────────────────────────────────────────────
// Stats.
// ───────────────────────────────────────────────────────────────────────────
interface StatsArgs {
  symbol: SymbolId;
  period: StrategyPeriod;
  interval: string;
  startEquity: number;
  endEquity: number;
  candles: KlineCandle[];
  closes: number[];
  trades: BacktestTrade[];
  parsed: ParsedStrategy;
  equityCurve: EquityPoint[];
}

function computeStats(args: StatsArgs): BacktestStats {
  const { trades, equityCurve } = args;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWinPct = wins.length > 0 ? avg(wins.map((t) => t.pnlPct)) : 0;
  const avgLossPct = losses.length > 0 ? avg(losses.map((t) => t.pnlPct)) : 0;
  const largestWinPct = wins.length > 0 ? Math.max(...wins.map((t) => t.pnlPct)) : 0;
  const largestLossPct = losses.length > 0 ? Math.min(...losses.map((t) => t.pnlPct)) : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor =
    grossLoss === 0 ? (grossWin === 0 ? 0 : Number.POSITIVE_INFINITY) : grossWin / grossLoss;

  const maxDrawdownPct = computeMaxDrawdown(equityCurve);
  const sharpe = computeSharpe(equityCurve, args.interval);

  const startTs = args.candles[0]?.closeTime ?? 0;
  const endTs = args.candles[args.candles.length - 1]?.closeTime ?? 0;
  const startPx = args.candles[0]?.close ?? 0;
  const endPx = args.candles[args.candles.length - 1]?.close ?? startPx;
  const buyHoldReturnPct = startPx > 0 ? ((endPx - startPx) / startPx) * 100 : 0;

  const totalReturnPct =
    args.startEquity > 0 ? ((args.endEquity - args.startEquity) / args.startEquity) * 100 : 0;

  return {
    symbol: args.symbol,
    period: args.period,
    interval: args.interval,
    startTs,
    endTs,
    startEquity: args.startEquity,
    endEquity: args.endEquity,
    totalReturnPct,
    buyHoldReturnPct,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinPct,
    avgLossPct,
    largestWinPct,
    largestLossPct,
    profitFactor,
    maxDrawdownPct,
    sharpe,
    avgBarsHeld: trades.length > 0 ? avg(trades.map((t) => t.bars)) : 0,
    totalPnlUsd: args.endEquity - args.startEquity,
  };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function computeMaxDrawdown(curve: EquityPoint[]): number {
  if (curve.length === 0) return 0;
  let peak = curve[0].equity;
  let maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

const BARS_PER_YEAR: Record<string, number> = {
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
};

function computeSharpe(curve: EquityPoint[], interval: string): number {
  if (curve.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1].equity;
    const cur = curve[i].equity;
    if (prev <= 0) continue;
    returns.push((cur - prev) / prev);
  }
  if (returns.length === 0) return 0;
  const mean = avg(returns);
  const variance = avg(returns.map((r) => (r - mean) ** 2));
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  const annFactor = Math.sqrt(BARS_PER_YEAR[interval] ?? 365);
  return (mean / stdev) * annFactor;
}

function downsample(curve: EquityPoint[], maxPoints: number): EquityPoint[] {
  if (curve.length <= maxPoints) return curve;
  const step = curve.length / maxPoints;
  const out: EquityPoint[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(curve.length - 1, Math.floor(i * step));
    out.push(curve[idx]);
  }
  out.push(curve[curve.length - 1]);
  return out;
}

function computeStopDist(parsed: ParsedStrategy, close: number, atrVal: number): number {
  if (parsed.risk.stopLossPct) return close * parsed.risk.stopLossPct;
  if (parsed.risk.stopAtrMult && atrVal > 0) return atrVal * parsed.risk.stopAtrMult;
  // Fallback: 2% stop so backtests still produce sensible numbers when the
  // user didn't specify any risk.
  return close * 0.02;
}

function computeTargetDist(parsed: ParsedStrategy, close: number, atrVal: number): number {
  if (parsed.risk.takeProfitPct) return close * parsed.risk.takeProfitPct;
  if (parsed.risk.targetAtrMult && atrVal > 0) return atrVal * parsed.risk.targetAtrMult;
  return close * 0.04;
}

function emptyResult(input: BacktestInput): BacktestResult {
  const start = input.candles[0]?.closeTime ?? Date.now();
  const end = input.candles[input.candles.length - 1]?.closeTime ?? Date.now();
  return {
    stats: {
      symbol: input.symbol,
      period: input.period,
      interval: input.interval,
      startTs: start,
      endTs: end,
      startEquity: input.parsed.notional,
      endEquity: input.parsed.notional,
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
    },
    equityCurve: [],
    trades: [],
    parsed: input.parsed,
  };
}
