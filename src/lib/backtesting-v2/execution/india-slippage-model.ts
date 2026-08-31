/**
 * india-slippage-model.ts — Realistic, instrument-aware slippage model for NSE/NFO.
 *
 * Slippage components modelled:
 *   1. Bid/ask spread cost        — half-spread paid on entry, half on exit
 *   2. Market impact              — function of (order size / bar volume)
 *   3. Volatility adjustment      — ATR-scaled; widens slippage in fast markets
 *   4. Options liquidity penalty  — OTM/illiquid options carry extra slippage
 *
 * Fill price calculation:
 *   BUY  fill = ask + market_impact  (ask = midPrice + halfSpread)
 *   SELL fill = bid - market_impact  (bid = midPrice - halfSpread)
 *
 * The model does NOT use a fixed global bps value. Every parameter varies
 * with instrument type, strike moneyness, volume, OI, and ATR.
 */

import type { InstrumentId, InstrumentType } from "../events/market-event";
import type { OHLCVBar } from "../events/market-event";
import type { MarketDepthSnapshot } from "./market-depth";
import { MarketDepthSimulator, inferLiquidityTier } from "./market-depth";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface IndiaSlippageConfig {
  /**
   * Market impact coefficient.
   * Impact fraction = impactCoeff × (orderUnits / barVolume).
   * Default: 0.1 — a 10% participation rate adds 1% slippage.
   */
  impactCoeff: number;

  /**
   * Volatility (ATR) multiplier.
   * Extra slippage = atrMultiplier × (ATR / price) when ATR/price > atrThreshold.
   * Default: 0.5.
   */
  atrMultiplier: number;

  /**
   * ATR/price ratio above which the volatility adjustment kicks in.
   * Default: 0.005 (0.5%).
   */
  atrThreshold: number;

  /**
   * Options-specific: additional slippage penalty as fraction of premium for
   * OTM and deep-OTM options (layered on top of spread cost).
   * Tiers: NTM, OTM, DEEP_OTM receive progressive penalties.
   * Default: { NTM: 0.005, OTM: 0.015, DEEP_OTM: 0.04 }
   */
  optionOtmPenalty: {
    NTM_OPTION: number;
    OTM_OPTION: number;
    DEEP_OTM: number;
  };

  /**
   * Maximum total slippage as a fraction of price (safety cap).
   * Default: 0.05 (5%).
   */
  maxSlippageFraction: number;

  /**
   * Depth-levels multiplier for the synthetic book.
   * Default: 5.
   */
  depthLevels: number;

  /**
   * Spread multiplier for stressed-market regimes.
   * Set > 1 via strategy overrides when simulating high-volatility sessions.
   * Default: 1.0.
   */
  spreadMultiplier: number;
}

export const DEFAULT_INDIA_SLIPPAGE_CONFIG: IndiaSlippageConfig = {
  impactCoeff:    0.1,
  atrMultiplier:  0.5,
  atrThreshold:   0.005,
  optionOtmPenalty: {
    NTM_OPTION: 0.005,
    OTM_OPTION: 0.015,
    DEEP_OTM:   0.040,
  },
  maxSlippageFraction: 0.05,
  depthLevels:    5,
  spreadMultiplier: 1.0,
};

// ── Result ────────────────────────────────────────────────────────────────────

export interface IndiaSlippageResult {
  /** Reference price before any slippage (typically bar open or limit price). */
  idealPrice: number;
  /** Final fill price after all slippage components. */
  slippedPrice: number;
  /** Total slippage amount (always non-negative, in INR per unit). */
  slippageAmount: number;
  /** Slippage as fraction of ideal price. */
  slippageFraction: number;
  /** Breakdown by component. */
  breakdown: {
    spreadCost:     number;   // half-spread paid (price units)
    marketImpact:   number;   // size-based impact (price units)
    volAdjustment:  number;   // ATR-based extra cost (price units)
    otmPenalty:     number;   // options OTM liquidity penalty (price units)
  };
  /** The depth snapshot used for this calculation (for audit). */
  depth: MarketDepthSnapshot;
}

// ── IndiaSlippageModel ────────────────────────────────────────────────────────

export class IndiaSlippageModel {
  private readonly cfg: IndiaSlippageConfig;
  private readonly depthSim: MarketDepthSimulator;

  constructor(config: Partial<IndiaSlippageConfig> = {}) {
    this.cfg = { ...DEFAULT_INDIA_SLIPPAGE_CONFIG, ...config };
    this.depthSim = new MarketDepthSimulator({
      depthLevels: this.cfg.depthLevels,
      spreadMultiplier: this.cfg.spreadMultiplier,
    });
  }

  /**
   * Calculate slippage for an order.
   *
   * @param instrument  Instrument metadata
   * @param bar         Current OHLCV bar
   * @param side        BUY or SELL
   * @param idealPrice  Intended fill price (e.g. bar open for market orders)
   * @param orderQty    Order quantity in lots (F&O) or shares (equity)
   * @param atr         Optional ATR for volatility adjustment
   */
  apply(
    instrument: InstrumentId,
    bar: OHLCVBar,
    side: "BUY" | "SELL",
    idealPrice: number,
    orderQty: number,
    atr?: number,
  ): IndiaSlippageResult {
    const depth = this.depthSim.snapshot(instrument, bar, atr);
    const orderUnits = orderQty * instrument.lotSize;  // shares / contracts in market units

    // ── 1. Spread cost (half-spread per leg) ─────────────────────────────
    const spreadCost = depth.spread / 2;

    // ── 2. Market impact ──────────────────────────────────────────────────
    // Walk the book to get VWAP; difference from best bid/ask is impact.
    const { vwapPrice } = this.depthSim.walkBook(side, orderUnits, depth);
    const bookRef = side === "BUY" ? depth.bestAsk : depth.bestBid;
    const marketImpact = Math.abs(vwapPrice - bookRef);

    // ── 3. Volatility adjustment ──────────────────────────────────────────
    let volAdjustment = 0;
    if (atr !== undefined && atr > 0 && idealPrice > 0) {
      const atrPct = atr / idealPrice;
      if (atrPct > this.cfg.atrThreshold) {
        volAdjustment = idealPrice * this.cfg.atrMultiplier * (atrPct - this.cfg.atrThreshold);
      }
    }

    // ── 4. Options OTM liquidity penalty ─────────────────────────────────
    let otmPenalty = 0;
    const itype = instrument.instrumentType;
    if (itype === "OPTIDX" || itype === "OPTSTK") {
      const tier = depth.liquidityTier;
      const penaltyFrac = this.cfg.optionOtmPenalty[tier as keyof typeof this.cfg.optionOtmPenalty] ?? 0;
      otmPenalty = idealPrice * penaltyFrac;
    }

    // ── Compose total slippage ────────────────────────────────────────────
    const rawSlippage = spreadCost + marketImpact + volAdjustment + otmPenalty;

    // Cap at maxSlippageFraction
    const maxSlippage = idealPrice * this.cfg.maxSlippageFraction;
    const slippageAmount = Math.min(rawSlippage, maxSlippage);
    const slippageFraction = idealPrice > 0 ? slippageAmount / idealPrice : 0;

    // Direction: buys pay more, sells receive less
    const slippedPrice = side === "BUY"
      ? idealPrice + slippageAmount
      : idealPrice - slippageAmount;

    return {
      idealPrice,
      slippedPrice,
      slippageAmount,
      slippageFraction,
      breakdown: {
        spreadCost:    Math.min(spreadCost,    maxSlippage),
        marketImpact:  Math.min(marketImpact,  maxSlippage),
        volAdjustment: Math.min(volAdjustment, maxSlippage),
        otmPenalty:    Math.min(otmPenalty,    maxSlippage),
      },
      depth,
    };
  }
}
