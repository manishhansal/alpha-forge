/**
 * FillModel — decides whether and at what price an order is executed.
 *
 * The interface is intentionally minimal: given a pending order and the
 * current bar's OHLCV data, return a FillEvent (filled) or null (not filled).
 *
 * Concrete implementations:
 *   • MarketFillModel  — always fills at open ± slippage
 *   • NextBarOpenModel — fills at next bar's open (default for backtesting)
 *   • LimitFillModel   — fills only when the bar's high/low crosses the limit
 *
 * All models delegate slippage to a `SlippageModel` and commission to a
 * `CommissionModel`, keeping the three concerns orthogonal.
 */

import type { OrderRecord } from "../models/order";
import type { OHLCVBar } from "../events/market-event";
import type { FillEvent } from "../events/fill-event";
import { buildFillEvent } from "../events/fill-event";
import { SlippageModel, DEFAULT_SLIPPAGE_CONFIG } from "./slippage-model";
import { CommissionModel } from "./commission-model";
import type { SlippageConfig } from "./slippage-model";
import type { CommissionConfig, InstrumentSegment } from "./commission-model";

// ── FillModel interface ────────────────────────────────────────────────────────

export interface FillModel {
  /**
   * Attempt to fill `order` against `bar`.
   *
   * @param order         The active order record
   * @param bar           The current bar's OHLCV data
   * @param barIndex      Current bar index
   * @param timestampMs   UTC ms of bar close
   * @returns             FillEvent if filled, null if not
   */
  tryFill(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null;
}

// ── Fill model config ─────────────────────────────────────────────────────────

export interface FillModelConfig {
  slippage?: Partial<SlippageConfig>;
  commission?: Partial<CommissionConfig>;
  segment?: InstrumentSegment;
}

// ── Shared fill builder ───────────────────────────────────────────────────────

function buildFill(
  order: OrderRecord,
  grossPrice: number,
  slippageAmt: number,
  barIndex: number,
  timestampMs: number,
  commissionModel: CommissionModel,
  segment: InstrumentSegment,
): FillEvent {
  const isBuy = order.side === "BUY";
  const commission = commissionModel.total(
    grossPrice,
    order.qty,
    order.instrument.lotSize,
    segment,
    isBuy,
  );

  return buildFillEvent({
    sourceEventId: order.orderEventId,
    orderEventId: order.orderEventId,
    signalEventId: order.signalEventId,
    timestampMs,
    instrument: order.instrument,
    side: order.side,
    intent: order.intent,
    direction: order.direction,
    qty: order.qty,
    fillPrice: grossPrice,
    commission,
    slippage: slippageAmt,
    // signalTimestampMs comes from the order record (= bar close when signal fired)
    signalTimestampMs: order.signalTimestampMs,
    executionTimestampMs: timestampMs,
    executionBarIndex: barIndex,
  });
}

// ── NextBarOpenFillModel (default for NSE backtesting) ────────────────────────

/**
 * The realistic default for NSE backtesting.
 *
 * Orders generated at bar N's close are filled at bar N+1's open with
 * slippage applied. The `validFromBarIndex` check is the anti-lookahead gate.
 */
export class NextBarOpenFillModel implements FillModel {
  private readonly slippage: SlippageModel;
  private readonly commission: CommissionModel;
  private readonly segment: InstrumentSegment;

  constructor(config: FillModelConfig = {}) {
    this.slippage = new SlippageModel(config.slippage ?? DEFAULT_SLIPPAGE_CONFIG);
    this.commission = new CommissionModel(config.commission ?? {});
    this.segment = config.segment ?? "FO_OPTIONS";
  }

  tryFill(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    // Anti-lookahead: order not yet valid for this bar
    if (barIndex < order.validFromBarIndex) return null;
    if (barIndex > order.expiryBarIndex) return null;

    // Fill at bar open (this bar IS the "next bar" after the signal)
    const idealPrice = bar.open;
    const { slippedPrice, slippageAmount } = this.slippage.apply(
      idealPrice,
      order.side,
      order.qty,
      order.instrument.lotSize,
    );

    return buildFill(order, slippedPrice, slippageAmount, barIndex, bar.openMs, this.commission, this.segment);
  }
}

// ── MarketFillModel ───────────────────────────────────────────────────────────

/**
 * Fills immediately at bar close. Primarily useful for tests that need
 * same-bar fills. Do NOT use for realistic backtesting — introduces
 * lookahead bias when paired with a strategy that generates signals at close.
 */
export class MarketFillModel implements FillModel {
  private readonly slippage: SlippageModel;
  private readonly commission: CommissionModel;
  private readonly segment: InstrumentSegment;

  constructor(config: FillModelConfig = {}) {
    this.slippage = new SlippageModel(config.slippage ?? DEFAULT_SLIPPAGE_CONFIG);
    this.commission = new CommissionModel(config.commission ?? {});
    this.segment = config.segment ?? "FO_OPTIONS";
  }

  tryFill(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    if (barIndex < order.validFromBarIndex) return null;
    if (barIndex > order.expiryBarIndex) return null;

    const idealPrice = bar.close;
    const { slippedPrice, slippageAmount } = this.slippage.apply(
      idealPrice,
      order.side,
      order.qty,
      order.instrument.lotSize,
    );

    return buildFill(order, slippedPrice, slippageAmount, barIndex, timestampMs, this.commission, this.segment);
  }
}

// ── LimitFillModel ────────────────────────────────────────────────────────────

/**
 * Fills when the bar's high/low crosses the limit price.
 * Buys fill when `bar.low <= limitPrice`; sells when `bar.high >= limitPrice`.
 */
export class LimitFillModel implements FillModel {
  private readonly slippage: SlippageModel;
  private readonly commission: CommissionModel;
  private readonly segment: InstrumentSegment;

  constructor(config: FillModelConfig = {}) {
    this.slippage = new SlippageModel(config.slippage ?? DEFAULT_SLIPPAGE_CONFIG);
    this.commission = new CommissionModel(config.commission ?? {});
    this.segment = config.segment ?? "FO_OPTIONS";
  }

  tryFill(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    if (barIndex < order.validFromBarIndex) return null;
    if (barIndex > order.expiryBarIndex) return null;
    if (order.limitPrice === undefined) return null;

    const limit = order.limitPrice;
    const touched =
      order.side === "BUY" ? bar.low <= limit : bar.high >= limit;

    if (!touched) return null;

    const { slippedPrice, slippageAmount } = this.slippage.apply(
      limit,
      order.side,
      order.qty,
      order.instrument.lotSize,
    );

    return buildFill(order, slippedPrice, slippageAmount, barIndex, timestampMs, this.commission, this.segment);
  }
}
