import type { ScalpStrategyModule } from "@/features/scalping/strategies/types";
import type {
  ScalpDirection,
  ScalpStrategyId,
  ScalpTimeframe,
} from "@/features/scalping/types";
import type { KlineCandle, SymbolId } from "@/types/market";

/**
 * The strategy context wants one of the live scalper timeframes (1m / 5m /
 * 15m) but historical backtests run on coarser bars (4h, 1d, …). We pass
 * `"15m"` to the strategy as a harmless placeholder — strategies only feed
 * the value through to `signal.timeframe`; none of them branch on it — and
 * record the *real* bar size in `ScalpBacktestStats.interval`.
 */
const STRATEGY_TIMEFRAME_HINT: ScalpTimeframe = "15m";

/**
 * Single-strategy historical backtester for the scalping engine.
 *
 * Walks a candle stream bar-by-bar and at every closed bar feeds a trailing
 * window of history into the strategy module. When the strategy returns a
 * signal whose `triggeredAt` equals the current bar's close time, we open a
 * paper position at the signal's `entry` and walk forward checking each
 * future bar's high/low for stop-loss / take-profit touches.
 *
 * The window-based replay keeps the run linear in the number of bars: each
 * strategy invocation only sees the last `windowBars` candles, so a five-year
 * 4h backtest stays well under a second per strategy. Indicator warm-up
 * inside the strategy still works because the window is large enough for
 * every indicator's period (EMA200, rolling VWAP 96, ATR 14, …) to have
 * meaningful values.
 *
 * Resolution mirrors the live paper-trader:
 *   - WIN  : a candle's high (LONG) / low (SHORT) crossed `target`
 *   - LOSS : a candle's low (LONG) / high (SHORT) crossed `stopLoss`
 *   - EXPIRED: max hold reached without either being hit
 *   - EOD : end-of-data on the last candle, mark-to-market on close
 * Conservative tie-break: a candle that touches both is recorded as a stop.
 */

export interface ScalpBacktestTrade {
  side: ScalpDirection;
  entry: number;
  exit: number;
  reason: "STOP" | "TARGET" | "EXPIRED" | "EOD";
  openedAt: number;
  closedAt: number;
  /** Per-trade P&L in %. */
  pnlPct: number;
  /** Per-trade P&L in USD on the configured `notional`. */
  pnlUsd: number;
  /** Bars held before resolution. */
  bars: number;
  /** Strategy confidence at entry (0..1). */
  confidence: number;
}

export interface ScalpBacktestEquityPoint {
  ts: number;
  equity: number;
}

export interface ScalpBacktestStats {
  strategyId: ScalpStrategyId;
  symbol: SymbolId;
  /** Bar interval the backtest ran on (e.g. `4h`). */
  interval: string;
  startTs: number;
  endTs: number;
  /** Initial equity (USD). */
  startEquity: number;
  /** Final equity (USD) = startEquity + Σ trade P&L. */
  endEquity: number;
  /** Strategy total return on initial equity (%). */
  totalReturnPct: number;
  /** Buy & hold benchmark return over the same window (%). */
  buyHoldReturnPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  expired: number;
  /** wins / totalTrades. 0 when no trades. */
  winRate: number;
  /** Σ winUsd / |Σ lossUsd|. Infinity when no losses. */
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  largestWinPct: number;
  largestLossPct: number;
  /** Peak-to-trough drawdown on the equity curve (0..1). */
  maxDrawdownPct: number;
  /** Annualised Sharpe approximation from bar-level returns. */
  sharpe: number;
  /** Average bars in a closed trade. */
  avgBarsHeld: number;
  /** Σ trade P&L in USD. */
  totalPnlUsd: number;
  /** Candle bars scanned (post-warmup). */
  barsScanned: number;
}

export interface ScalpBacktestResult {
  stats: ScalpBacktestStats;
  equityCurve: ScalpBacktestEquityPoint[];
  trades: ScalpBacktestTrade[];
}

export interface ScalpBacktestInput {
  mod: ScalpStrategyModule;
  symbol: SymbolId;
  /** Bar interval label for stats + Sharpe annualisation (e.g. `4h`). */
  interval: string;
  candles: KlineCandle[];
  /** Starting equity (USD). Trade P&L accumulates onto this. */
  startEquity: number;
  /** Per-trade notional (USD). Fixed — not compounded — so win-rate, drawdown
   *  and profit factor stay comparable across strategies. */
  notional: number;
  /** Force-close trades that haven't hit SL/TP after this many bars. */
  maxHoldBars?: number;
  /** Override the trailing slice size. Defaults to `max(mod.warmup * 2, 256)`. */
  windowBars?: number;
}

/**
 * Run a single strategy module over a candle history and produce the trade
 * log, equity curve and aggregate stats.
 */
export function backtestStrategy(input: ScalpBacktestInput): ScalpBacktestResult {
  const {
    mod,
    symbol,
    interval,
    candles,
    startEquity,
    notional,
    maxHoldBars = 48,
  } = input;

  const n = candles.length;
  const windowBars = Math.max(input.windowBars ?? 0, mod.warmup * 2, 256);
  const trades: ScalpBacktestTrade[] = [];
  const equityCurve: ScalpBacktestEquityPoint[] = [];

  if (n < windowBars + 1) {
    return {
      stats: buildEmptyStats(mod.id, symbol, interval, startEquity, candles),
      equityCurve,
      trades,
    };
  }

  type Position = {
    side: ScalpDirection;
    entry: number;
    stop: number;
    target: number;
    openedBar: number;
    openedAt: number;
    confidence: number;
  };
  let pos: Position | null = null;
  let equity = startEquity;

  const start = windowBars;
  for (let i = start; i < n; i += 1) {
    const candle = candles[i];

    // ── Resolve open position against the current bar ─────────────────────
    if (pos) {
      const isLong = pos.side === "LONG";
      let closed = false;
      let exitPrice = candle.close;
      let reason: ScalpBacktestTrade["reason"] = "EOD";

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
      } else if (i - pos.openedBar >= maxHoldBars) {
        exitPrice = candle.close;
        reason = "EXPIRED";
        closed = true;
      } else if (i === n - 1) {
        exitPrice = candle.close;
        reason = "EOD";
        closed = true;
      }

      if (closed) {
        const pnlPct = pnlPercent(pos.entry, exitPrice, isLong);
        const pnlUsd = (pnlPct / 100) * notional;
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
          confidence: pos.confidence,
        });
        pos = null;
      }
    }

    // ── Look for a fresh signal when flat ─────────────────────────────────
    if (!pos) {
      const sliceStart = Math.max(0, i + 1 - windowBars);
      const slice = candles.slice(sliceStart, i + 1);
      let sig = null;
      try {
        sig = mod.run({
          symbol,
          timeframe: STRATEGY_TIMEFRAME_HINT,
          candles: slice,
          lookback: 1,
        });
      } catch {
        sig = null;
      }
      if (sig && sig.triggeredAt === candle.closeTime) {
        const stopDist = Math.abs(sig.entry - sig.stopLoss);
        const targetDist = Math.abs(sig.target - sig.entry);
        // Guard against pathological signals where SL/TP collapse to entry.
        if (stopDist > 0 && targetDist > 0) {
          pos = {
            side: sig.direction,
            entry: sig.entry,
            stop: sig.stopLoss,
            target: sig.target,
            openedBar: i,
            openedAt: candle.closeTime,
            confidence: sig.confidence,
          };
        }
      }
    }

    equityCurve.push({ ts: candle.closeTime, equity });
  }

  const sampledCurve = downsample(equityCurve, 200);

  return {
    stats: buildStats({
      strategyId: mod.id,
      symbol,
      interval,
      startEquity,
      endEquity: equity,
      candles,
      windowStartBar: start,
      trades,
      equityCurve,
    }),
    equityCurve: sampledCurve,
    trades,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Stats helpers.
// ───────────────────────────────────────────────────────────────────────────

interface StatsArgs {
  strategyId: ScalpStrategyId;
  symbol: SymbolId;
  interval: string;
  startEquity: number;
  endEquity: number;
  candles: KlineCandle[];
  windowStartBar: number;
  trades: ScalpBacktestTrade[];
  equityCurve: ScalpBacktestEquityPoint[];
}

function buildStats(a: StatsArgs): ScalpBacktestStats {
  const { trades, equityCurve } = a;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const expired = trades.filter((t) => t.reason === "EXPIRED" || t.reason === "EOD");

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
  const sharpe = computeSharpe(equityCurve, a.interval);

  const firstBar = a.candles[a.windowStartBar] ?? a.candles[0];
  const lastBar = a.candles[a.candles.length - 1];
  const startTs = firstBar?.closeTime ?? 0;
  const endTs = lastBar?.closeTime ?? 0;
  const startPx = firstBar?.close ?? 0;
  const endPx = lastBar?.close ?? startPx;
  const buyHoldReturnPct = startPx > 0 ? ((endPx - startPx) / startPx) * 100 : 0;
  const totalReturnPct =
    a.startEquity > 0 ? ((a.endEquity - a.startEquity) / a.startEquity) * 100 : 0;

  return {
    strategyId: a.strategyId,
    symbol: a.symbol,
    interval: a.interval,
    startTs,
    endTs,
    startEquity: a.startEquity,
    endEquity: a.endEquity,
    totalReturnPct,
    buyHoldReturnPct,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winRate,
    profitFactor,
    avgWinPct,
    avgLossPct,
    largestWinPct,
    largestLossPct,
    maxDrawdownPct,
    sharpe,
    avgBarsHeld: trades.length > 0 ? avg(trades.map((t) => t.bars)) : 0,
    totalPnlUsd: a.endEquity - a.startEquity,
    barsScanned: a.candles.length - a.windowStartBar,
  };
}

function buildEmptyStats(
  strategyId: ScalpStrategyId,
  symbol: SymbolId,
  interval: string,
  startEquity: number,
  candles: KlineCandle[],
): ScalpBacktestStats {
  const startTs = candles[0]?.closeTime ?? 0;
  const endTs = candles[candles.length - 1]?.closeTime ?? 0;
  return {
    strategyId,
    symbol,
    interval,
    startTs,
    endTs,
    startEquity,
    endEquity: startEquity,
    totalReturnPct: 0,
    buyHoldReturnPct: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    winRate: 0,
    profitFactor: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    largestWinPct: 0,
    largestLossPct: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    avgBarsHeld: 0,
    totalPnlUsd: 0,
    barsScanned: 0,
  };
}

function pnlPercent(entry: number, exit: number, isLong: boolean): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function computeMaxDrawdown(curve: ScalpBacktestEquityPoint[]): number {
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
  "1m": 365 * 24 * 60,
  "5m": 365 * 24 * 12,
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
};

function computeSharpe(curve: ScalpBacktestEquityPoint[], interval: string): number {
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

function downsample(
  curve: ScalpBacktestEquityPoint[],
  maxPoints: number,
): ScalpBacktestEquityPoint[] {
  if (curve.length <= maxPoints) return curve.slice();
  const step = curve.length / maxPoints;
  const out: ScalpBacktestEquityPoint[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(curve.length - 1, Math.floor(i * step));
    out.push(curve[idx]);
  }
  out.push(curve[curve.length - 1]);
  return out;
}
