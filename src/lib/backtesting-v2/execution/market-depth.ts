/**
 * market-depth.ts — Bid/ask spread and synthetic market depth simulator.
 *
 * Simulates a realistic NSE/NFO order book using instrument characteristics:
 *   • Instrument type (EQ, FUTURES, OPTIONS)
 *   • Volatility / ATR
 *   • Volume and open interest
 *   • Moneyness for options (deep ITM / ATM / OTM)
 *
 * The depth model synthesises a 5-level bid/ask book from a single OHLCV bar.
 * This lets the slippage model "walk the book" for large orders rather than
 * using a single spread estimate.
 *
 * NSE empirical spread guidelines (as of 2024-25):
 *   Large-cap equity (NIFTY50):       0.01–0.05%  of price
 *   Mid-cap equity:                   0.05–0.25%  of price
 *   Small-cap / illiquid equity:      0.25–2.0%   of price
 *   NIFTY / BANKNIFTY futures:        0.02–0.05%  of price
 *   Stock futures (liquid):           0.05–0.20%  of price
 *   ATM index options (NIFTY/BNF):    0.05–0.15%  of price
 *   OTM index options (1–2 strikes):  0.20–1.0%   of price
 *   Far OTM / illiquid options:       1.0–5.0%+   of price (can be wider than tick)
 */

import type { InstrumentId, InstrumentType } from "../events/market-event";
import type { OHLCVBar } from "../events/market-event";

// ── Instrument liquidity profile ──────────────────────────────────────────────

export type LiquidityTier =
  | "LARGE_CAP"     // NIFTY 50 stocks, NIFTY/BANKNIFTY futures
  | "MID_CAP"       // NIFTY 100-500 stocks, liquid stock futures
  | "SMALL_CAP"     // Below NIFTY 500, thinly-traded contracts
  | "ATM_OPTION"    // Option within 1 strike of spot
  | "NTM_OPTION"    // Near-the-money: 1–3 strikes away
  | "OTM_OPTION"    // 3–6 strikes away
  | "DEEP_OTM";     // 6+ strikes away or near-expiry OTM

export interface MarketDepthConfig {
  /**
   * Liquidity tier — drives spread and depth heuristics.
   * Auto-derived from instrument when not provided.
   */
  liquidityTier?: LiquidityTier;
  /**
   * Number of depth levels to simulate. Default: 5.
   * Each level represents an order queue at a tick increment away.
   */
  depthLevels?: number;
  /**
   * Multiplier on the base spread for "stressed" market conditions.
   * Set > 1 for high-volatility regimes. Default: 1.0.
   */
  spreadMultiplier?: number;
}

// ── Single depth level ────────────────────────────────────────────────────────

export interface DepthLevel {
  /** Price of this level. */
  price: number;
  /** Available quantity (shares / contracts) at this level. */
  qty: number;
}

// ── Simulated order book snapshot ────────────────────────────────────────────

export interface MarketDepthSnapshot {
  /** Best bid price (highest bid). */
  bestBid: number;
  /** Best ask price (lowest ask). */
  bestAsk: number;
  /** Effective bid/ask spread in price units. */
  spread: number;
  /** Spread as fraction of mid price. */
  spreadFraction: number;
  /** Mid price = (bestBid + bestAsk) / 2 */
  midPrice: number;
  /** Ordered bid levels: [0] = best bid, [N-1] = deepest bid. */
  bids: DepthLevel[];
  /** Ordered ask levels: [0] = best ask, [N-1] = deepest ask. */
  asks: DepthLevel[];
  /** Total available bid liquidity (qty) across all levels. */
  totalBidQty: number;
  /** Total available ask liquidity (qty) across all levels. */
  totalAskQty: number;
  /** Liquidity tier used for this snapshot. */
  liquidityTier: LiquidityTier;
}

// ── Spread fractions by tier and instrument type ──────────────────────────────

/** Half-spread fractions (one side) per liquidity tier. */
const HALF_SPREAD_FRACTION: Record<LiquidityTier, number> = {
  LARGE_CAP:   0.0001,  // 1 bps
  MID_CAP:     0.0005,  // 5 bps
  SMALL_CAP:   0.0020,  // 20 bps
  ATM_OPTION:  0.0010,  // 10 bps of premium
  NTM_OPTION:  0.0025,  // 25 bps
  OTM_OPTION:  0.0075,  // 75 bps
  DEEP_OTM:    0.0200,  // 200 bps — can exceed tick size many times over
};

/**
 * Base depth qty (contracts/shares) at best bid/ask.
 * Deeper levels have exponentially less liquidity.
 */
const BASE_DEPTH_QTY: Record<LiquidityTier, number> = {
  LARGE_CAP:   50_000,
  MID_CAP:     10_000,
  SMALL_CAP:    1_000,
  ATM_OPTION:   2_000,
  NTM_OPTION:     500,
  OTM_OPTION:     100,
  DEEP_OTM:        20,
};

// ── Tier inference ────────────────────────────────────────────────────────────

/**
 * Infer liquidity tier from instrument metadata and bar data.
 *
 * For options: uses moneyness ratio (strike / LTP).
 * For equities: uses average daily volume.
 * Falls back to volume-based heuristics when other data is unavailable.
 */
export function inferLiquidityTier(
  instrument: InstrumentId,
  bar: OHLCVBar,
  openInterest?: number,
): LiquidityTier {
  const itype = instrument.instrumentType;

  // Options — moneyness-based classification
  if (itype === "OPTIDX" || itype === "OPTSTK") {
    return inferOptionTier(instrument, bar, openInterest);
  }

  // Futures
  if (itype === "FUTIDX") {
    // Index futures (NIFTY, BANKNIFTY) are always large-cap liquidity
    return "LARGE_CAP";
  }
  if (itype === "FUTSTK") {
    // Stock futures: volume-based
    return bar.volume > 500_000 ? "LARGE_CAP"
      : bar.volume > 50_000   ? "MID_CAP"
      : "SMALL_CAP";
  }

  // Equity (EQ)
  if (itype === "EQ") {
    // Approximate ADV from bar volume — rough cut for intraday bars
    // NIFTY50 stocks typically trade 500k+ shares per 5m bar
    if (bar.volume > 200_000) return "LARGE_CAP";
    if (bar.volume > 20_000)  return "MID_CAP";
    return "SMALL_CAP";
  }

  // Default for indices / unknown
  return "LARGE_CAP";
}

function inferOptionTier(
  instrument: InstrumentId,
  bar: OHLCVBar,
  openInterest?: number,
): LiquidityTier {
  const strike = instrument.strike;
  if (!strike || bar.close <= 0) return "OTM_OPTION";

  // Use LTP (bar close) as proxy for spot; moneyness = strike / spot
  const isCall = instrument.optionType === "CE";
  const ltp = bar.close;

  // For the underlying spot we use LTP — imperfect but sufficient for
  // spread estimation purposes in backtesting.
  // Moneyness ratio: strike / spot.
  // ATM: ratio ≈ 1.0 (within 1.5% of spot for index options)
  const spotProxy = isCall
    ? ltp / 0.5   // rough: if CE at 100, spot ≈ strike +/- something
    : ltp / 0.5;

  // Better: just check if OI and volume are both very low
  const isDeepOtm = (openInterest !== undefined && openInterest < 500) ||
    (bar.volume < 100 && ltp < 5);

  if (isDeepOtm) return "DEEP_OTM";

  // Low-OI, low-volume options — likely OTM
  if (openInterest !== undefined && openInterest < 5_000) return "OTM_OPTION";
  if (bar.volume < 500) return "OTM_OPTION";
  if (bar.volume < 5_000) return "NTM_OPTION";

  // High OI + high volume = ATM
  return "ATM_OPTION";
}

// ── MarketDepthSimulator ──────────────────────────────────────────────────────

export class MarketDepthSimulator {
  private readonly depthLevels: number;
  private readonly spreadMultiplier: number;
  private readonly fixedTier?: LiquidityTier;

  constructor(config: MarketDepthConfig = {}) {
    this.depthLevels = config.depthLevels ?? 5;
    this.spreadMultiplier = config.spreadMultiplier ?? 1.0;
    this.fixedTier = config.liquidityTier;
  }

  /**
   * Build a synthetic market depth snapshot for a given OHLCV bar.
   *
   * The model synthesises a plausible book around the bar's close price,
   * using instrument type and volume to parameterise spreads and depth.
   */
  snapshot(
    instrument: InstrumentId,
    bar: OHLCVBar,
    atr?: number,
  ): MarketDepthSnapshot {
    const tier = this.fixedTier ?? inferLiquidityTier(instrument, bar, bar.oi);
    const tickSize = instrument.tickSize > 0 ? instrument.tickSize : 0.05;
    const refPrice = bar.close;

    // Half-spread in price units (at minimum one tick)
    let halfSpreadFrac = HALF_SPREAD_FRACTION[tier] * this.spreadMultiplier;

    // ATR-based volatility adjustment: widen spreads in volatile sessions
    if (atr !== undefined && atr > 0 && refPrice > 0) {
      const atrPct = atr / refPrice;
      // Add 20% of ATR-pct to spread when volatility is elevated (> 0.5% bar ATR)
      if (atrPct > 0.005) {
        halfSpreadFrac *= (1 + atrPct * 4);
      }
    }

    const halfSpread = Math.max(tickSize, refPrice * halfSpreadFrac);

    const bestBid = this._round(refPrice - halfSpread, tickSize);
    const bestAsk = this._round(refPrice + halfSpread, tickSize);
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadFraction = midPrice > 0 ? spread / midPrice : 0;

    // Build depth levels — each level steps one tick further out
    // Qty decays exponentially: level[i] = base * 0.5^i
    const baseQty = this._adjustedBaseQty(tier, bar);
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];

    for (let i = 0; i < this.depthLevels; i++) {
      const qtyDecay = Math.pow(0.5, i);
      const levelQty = Math.max(1, Math.round(baseQty * qtyDecay));
      bids.push({
        price: this._round(bestBid - i * tickSize, tickSize),
        qty: levelQty,
      });
      asks.push({
        price: this._round(bestAsk + i * tickSize, tickSize),
        qty: levelQty,
      });
    }

    const totalBidQty = bids.reduce((s, l) => s + l.qty, 0);
    const totalAskQty = asks.reduce((s, l) => s + l.qty, 0);

    return {
      bestBid,
      bestAsk,
      spread,
      spreadFraction,
      midPrice,
      bids,
      asks,
      totalBidQty,
      totalAskQty,
      liquidityTier: tier,
    };
  }

  /**
   * Walk the order book for an order of `qty` units.
   * Returns the volume-weighted average fill price (VWAP) across levels hit.
   *
   * If total book depth is insufficient, the remaining unfilled qty is filled
   * at a penalty price (last level + 2 × spread), simulating market impact.
   */
  walkBook(
    side: "BUY" | "SELL",
    qty: number,       // total order qty in underlying units (shares/contracts)
    depth: MarketDepthSnapshot,
  ): { vwapPrice: number; filledQty: number; unfilledQty: number } {
    const levels = side === "BUY" ? depth.asks : depth.bids;
    let remaining = qty;
    let totalCost = 0;
    let filledQty = 0;

    for (const level of levels) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining, level.qty);
      totalCost += fillQty * level.price;
      filledQty += fillQty;
      remaining -= fillQty;
    }

    // Handle unfilled portion — market impact penalty
    if (remaining > 0) {
      const lastLevel = levels[levels.length - 1];
      const penaltyPrice = side === "BUY"
        ? lastLevel.price + depth.spread * 2
        : lastLevel.price - depth.spread * 2;
      totalCost += remaining * penaltyPrice;
      filledQty += remaining;
      remaining = 0;
    }

    const vwapPrice = filledQty > 0 ? totalCost / filledQty : depth.midPrice;
    return { vwapPrice, filledQty: qty - remaining, unfilledQty: remaining };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _round(price: number, tick: number): number {
    return Math.round(price / tick) * tick;
  }

  private _adjustedBaseQty(tier: LiquidityTier, bar: OHLCVBar): number {
    const base = BASE_DEPTH_QTY[tier];
    // Scale by actual bar volume — if volume is much lower than expected,
    // shrink the synthetic book proportionally
    if (bar.volume > 0) {
      const expectedVolPerBar = base * 10; // heuristic: 10 bars to exhaust one level
      const volRatio = Math.min(1, bar.volume / expectedVolPerBar);
      return Math.max(1, Math.round(base * volRatio));
    }
    return base;
  }
}
