/**
 * india-fill-model.ts — Realistic NSE/NFO fill simulation.
 *
 * Supports order types:
 *   MARKET      — fills at best available price (ask for buy, bid for sell) + impact
 *   LIMIT       — fills only when bar's low/high reaches the limit price; no fill = null
 *   STOP_MARKET — triggers when bar crosses stopTriggerPrice, then fills as market
 *   STOP_LIMIT  — triggers like STOP, but fills at limitPrice or better (or not at all)
 *
 * Partial fills:
 *   When order size exceeds available depth liquidity, a partial fill is returned.
 *   The remaining unfilled quantity is tracked in the fill result extras.
 *
 * Per-fill output (stored in FillEvent.extras):
 *   expectedPrice, actualFillPrice, slippageAmount, slippageFraction,
 *   fees (full breakdown), latency (all three components), fillQuality score,
 *   filledQty, unfilledQty, orderType, isPartialFill.
 *
 * This model does NOT modify the engine's live execution path. It implements
 * the FillModel interface and is injected via EventEngine.setFillModel().
 */

import type { OrderRecord } from "../models/order";
import type { OHLCVBar } from "../events/market-event";
import type { FillEvent } from "../events/fill-event";
import { buildFillEvent } from "../events/fill-event";
import type { IndiaSlippageConfig } from "./india-slippage-model";
import { IndiaSlippageModel } from "./india-slippage-model";
import type { IndiaBrokerageConfig, IndiaSegment } from "./india-brokerage-model";
import { IndiaBrokerageModel, toIndiaSegment } from "./india-brokerage-model";
import type { LatencyProfileName, LatencyProfileConfig } from "./latency-model";
import { LatencyModel } from "./latency-model";
import type { FillModel } from "./fill-model";

// ── Fill model config ─────────────────────────────────────────────────────────

export interface IndiaFillModelConfig {
  /** Slippage model config. Defaults to IndiaSlippageModel defaults. */
  slippage?: Partial<IndiaSlippageConfig>;
  /** Brokerage model config. Defaults to Zerodha profile. */
  brokerage?: Partial<IndiaBrokerageConfig>;
  /** Latency profile name or full config. Default: "MEDIUM". */
  latency?: LatencyProfileName | LatencyProfileConfig;
  /**
   * Treat equity positions as delivery (not intraday) for commission purposes.
   * Default: false (intraday / MIS assumed for backtesting).
   */
  equityDelivery?: boolean;
  /**
   * ATR values keyed by symbol. Used to improve slippage accuracy.
   * The fill model will use the ATR when available.
   */
  atrBySymbol?: Map<string, number>;
  /**
   * Partial fill threshold: if available depth is below this fraction of
   * order size, a partial fill is issued. Default: 0.2 (fill if >= 20% can be filled).
   * Set to 0 to always allow partial fills. Set to 1 to disallow partial fills.
   */
  partialFillThreshold?: number;
  /**
   * Bar duration in milliseconds. Used to decide if a STOP order triggered
   * "early" in the bar (which allows a realistic fill price).
   * Default: 5 * 60 * 1000 (5-minute bars).
   */
  barDurationMs?: number;
}

// ── Extended fill result (stored in FillEvent.extras) ────────────────────────

export interface IndiaFillExtras {
  expectedPrice:       number;
  actualFillPrice:     number;
  slippageAmount:      number;
  slippageFraction:    number;
  /** Full brokerage cost breakdown as a JSON string (extras must be primitive). */
  feesBreakdownJson:   string;
  totalFees:           number;
  latencySignalMs:     number;
  latencyNetworkMs:    number;
  latencyOrderMs:      number;
  latencyTotalMs:      number;
  /** Fill quality score 0–1 (1 = perfect, 0 = worst). */
  fillQuality:         number;
  filledQty:           number;
  unfilledQty:         number;
  orderType:           string;
  isPartialFill:       boolean;
  liquidityTier:       string;
  spreadFraction:      number;
  /** Index signature so this type is assignable to FillEvent.extras. */
  [key: string]:       string | number | boolean | null | undefined;
}

// ── IndiaFillModel ────────────────────────────────────────────────────────────

export class IndiaFillModel implements FillModel {
  private readonly slippage:   IndiaSlippageModel;
  private readonly brokerage:  IndiaBrokerageModel;
  private readonly latency:    LatencyModel;
  private readonly cfg:        Required<IndiaFillModelConfig>;

  constructor(config: IndiaFillModelConfig = {}) {
    this.cfg = {
      slippage:             config.slippage             ?? {},
      brokerage:            config.brokerage            ?? {},
      latency:              config.latency              ?? "MEDIUM",
      equityDelivery:       config.equityDelivery       ?? false,
      atrBySymbol:          config.atrBySymbol          ?? new Map(),
      partialFillThreshold: config.partialFillThreshold ?? 0.2,
      barDurationMs:        config.barDurationMs        ?? 5 * 60 * 1000,
    };
    this.slippage  = new IndiaSlippageModel(this.cfg.slippage);
    this.brokerage = new IndiaBrokerageModel(this.cfg.brokerage);
    this.latency   = new LatencyModel(this.cfg.latency);
  }

  // ── FillModel interface ──────────────────────────────────────────────────

  tryFill(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    // Anti-lookahead guards
    if (barIndex < order.validFromBarIndex) return null;
    if (barIndex > order.expiryBarIndex)    return null;

    const orderType = order.orderType;

    switch (orderType) {
      case "MARKET":
        return this._fillMarket(order, bar, barIndex, timestampMs);
      case "LIMIT":
        return this._fillLimit(order, bar, barIndex, timestampMs);
      case "STOP":
        return this._fillStopMarket(order, bar, barIndex, timestampMs);
      case "STOP_LIMIT":
        return this._fillStopLimit(order, bar, barIndex, timestampMs);
      default:
        return null;
    }
  }

  // ── MARKET order ──────────────────────────────────────────────────────────

  private _fillMarket(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    // Market orders fill at bar open (the realistic "next bar" price).
    const idealPrice = bar.open;
    return this._buildFill(order, bar, idealPrice, idealPrice, barIndex, timestampMs, "MARKET");
  }

  // ── LIMIT order ───────────────────────────────────────────────────────────

  private _fillLimit(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    if (order.limitPrice === undefined) return null;
    const limit = order.limitPrice;

    // Check if the bar actually reached the limit price.
    // BUY limit: bar.low must trade at or below the limit.
    // SELL limit: bar.high must trade at or above the limit.
    const reached =
      order.side === "BUY"
        ? bar.low <= limit
        : bar.high >= limit;

    if (!reached) return null;  // Limit not reached — no fill

    // Fill at the limit price (best case; slippage is applied on top).
    // If bar gaps through limit, fill at open (worse price).
    let idealPrice: number;
    if (order.side === "BUY") {
      // Gap down opens below limit → fill at open (better for buyer but
      // limit was never "resting" at that level).
      idealPrice = bar.open < limit ? bar.open : limit;
    } else {
      idealPrice = bar.open > limit ? bar.open : limit;
    }

    return this._buildFill(order, bar, limit, idealPrice, barIndex, timestampMs, "LIMIT");
  }

  // ── STOP_MARKET order ─────────────────────────────────────────────────────

  private _fillStopMarket(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    if (order.stopTriggerPrice === undefined) return null;
    const stop = order.stopTriggerPrice;

    // BUY stop: triggers when bar.high >= stop (e.g. breakout)
    // SELL stop: triggers when bar.low <= stop (e.g. stop-loss)
    const triggered =
      order.side === "BUY"
        ? bar.high >= stop
        : bar.low  <= stop;

    if (!triggered) return null;

    // Determine fill price:
    // - If bar opens through (gaps) the stop, fill at open.
    // - Otherwise fill at stop price (then slippage on top).
    let idealPrice: number;
    if (order.side === "BUY") {
      idealPrice = bar.open >= stop ? bar.open : stop;   // gap-up: fill at open
    } else {
      idealPrice = bar.open <= stop ? bar.open : stop;   // gap-down: fill at open
    }

    return this._buildFill(order, bar, stop, idealPrice, barIndex, timestampMs, "STOP");
  }

  // ── STOP_LIMIT order ──────────────────────────────────────────────────────

  private _fillStopLimit(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    if (order.stopTriggerPrice === undefined) return null;
    if (order.limitPrice === undefined)       return null;

    const stop  = order.stopTriggerPrice;
    const limit = order.limitPrice;

    // First check: is stop triggered?
    const triggered =
      order.side === "BUY"
        ? bar.high >= stop
        : bar.low  <= stop;

    if (!triggered) return null;

    // After trigger, check if limit is also reachable in the same bar.
    // BUY stop-limit: need bar.low <= limit (market must come back down to limit).
    // SELL stop-limit: need bar.high >= limit.
    const limitReachable =
      order.side === "BUY"
        ? bar.low <= limit
        : bar.high >= limit;

    if (!limitReachable) return null;  // Triggered but market ran away

    // Fill at limit price (slippage applied separately)
    let idealPrice: number;
    if (order.side === "BUY") {
      idealPrice = bar.open < limit ? bar.open : limit;
    } else {
      idealPrice = bar.open > limit ? bar.open : limit;
    }

    return this._buildFill(order, bar, stop, idealPrice, barIndex, timestampMs, "STOP_LIMIT");
  }

  // ── Core fill builder ─────────────────────────────────────────────────────

  private _buildFill(
    order:        OrderRecord,
    bar:          OHLCVBar,
    expectedPrice: number,    // price the trader expected (order price)
    idealPrice:   number,     // actual reference price before slippage
    barIndex:     number,
    timestampMs:  number,
    orderTypeLabel: string,
  ): FillEvent | null {
    const instrument = order.instrument;
    const atr = this.cfg.atrBySymbol.get(instrument.symbol);

    // ── Slippage ───────────────────────────────────────────────────────────
    const slippageResult = this.slippage.apply(
      instrument,
      bar,
      order.side,
      idealPrice,
      order.qty,
      atr,
    );

    // ── Partial fill check ────────────────────────────────────────────────
    const { depth } = slippageResult;
    const orderUnits   = order.qty * instrument.lotSize;
    const totalDepthQty = order.side === "BUY" ? depth.totalAskQty : depth.totalBidQty;
    const fillableUnits = Math.min(orderUnits, totalDepthQty);
    const fillableQty   = fillableUnits / instrument.lotSize;

    let filledQty   = order.qty;
    let unfilledQty = 0;

    if (totalDepthQty < orderUnits) {
      const fillFraction = totalDepthQty / orderUnits;
      if (fillFraction < this.cfg.partialFillThreshold) {
        // Below minimum threshold — no fill at all
        return null;
      }
      // Partial fill: round down to whole lots
      filledQty   = Math.max(1, Math.floor(fillableQty));
      unfilledQty = order.qty - filledQty;
    }

    const actualFillPrice = slippageResult.slippedPrice;

    // ── Brokerage / fees ──────────────────────────────────────────────────
    const segment = toIndiaSegment(
      instrument.instrumentType,
      !this.cfg.equityDelivery,
    ) as IndiaSegment;

    const isBuy = order.side === "BUY";
    const feesBreakdown = this.brokerage.calc(
      actualFillPrice,
      filledQty,
      instrument.lotSize,
      segment,
      isBuy,
    );

    // ── Latency ───────────────────────────────────────────────────────────
    const lat = this.latency.sample();

    // ── Fill quality score ────────────────────────────────────────────────
    // 1 = perfect fill (no slippage, no partial); 0 = worst (max slippage, partial)
    const fillQuality = this._calcFillQuality(
      slippageResult.slippageFraction,
      filledQty,
      order.qty,
      depth.liquidityTier,
    );

    // ── FillEvent extras ──────────────────────────────────────────────────
    const extras: IndiaFillExtras = {
      expectedPrice,
      actualFillPrice,
      slippageAmount:     slippageResult.slippageAmount,
      slippageFraction:   slippageResult.slippageFraction,
      feesBreakdownJson:  JSON.stringify(feesBreakdown),
      totalFees:          feesBreakdown.total,
      latencySignalMs:    lat.signalMs,
      latencyNetworkMs:   lat.networkMs,
      latencyOrderMs:     lat.orderProcessingMs,
      latencyTotalMs:     lat.totalMs,
      fillQuality,
      filledQty,
      unfilledQty,
      orderType:          orderTypeLabel,
      isPartialFill:      unfilledQty > 0,
      liquidityTier:      depth.liquidityTier,
      spreadFraction:     depth.spreadFraction,
    };

    return buildFillEvent({
      sourceEventId:       order.orderEventId,
      orderEventId:        order.orderEventId,
      signalEventId:       order.signalEventId,
      timestampMs:         bar.openMs,
      instrument,
      side:                order.side,
      intent:              order.intent,
      direction:           order.direction,
      qty:                 filledQty,
      fillPrice:           actualFillPrice,
      commission:          feesBreakdown.total,
      slippage:            slippageResult.slippageAmount,
      signalTimestampMs:   order.signalTimestampMs,
      executionTimestampMs: timestampMs,
      executionBarIndex:   barIndex,
      extras,
    });
  }

  // ── Fill quality score ────────────────────────────────────────────────────

  private _calcFillQuality(
    slippageFraction: number,
    filledQty: number,
    orderedQty: number,
    liquidityTier: string,
  ): number {
    // Slippage component: 0 at 0% slippage, 0 at >= 2% slippage
    const maxSlippageForScore = 0.02;
    const slippageScore = Math.max(
      0,
      1 - slippageFraction / maxSlippageForScore,
    );

    // Fill completeness component
    const fillScore = orderedQty > 0 ? filledQty / orderedQty : 1;

    // Liquidity bonus: reward trading liquid instruments
    const liquidityBonus: Record<string, number> = {
      LARGE_CAP:   0.05,
      MID_CAP:     0.02,
      SMALL_CAP:   0.00,
      ATM_OPTION:  0.02,
      NTM_OPTION:  0.00,
      OTM_OPTION:  -0.05,
      DEEP_OTM:    -0.10,
    };
    const bonus = liquidityBonus[liquidityTier] ?? 0;

    return Math.max(0, Math.min(1, slippageScore * 0.6 + fillScore * 0.4 + bonus));
  }
}
