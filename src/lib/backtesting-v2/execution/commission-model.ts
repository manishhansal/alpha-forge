/**
 * Commission model — realistic NSE/NFO brokerage cost simulation.
 *
 * Cost components modelled (per leg):
 *   • Brokerage         — flat ₹20 per executed order (Zerodha/Upstox model)
 *   • STT               — Securities Transaction Tax
 *                         Equity delivery: 0.1% on buy+sell; F&O sell: 0.025%
 *   • Exchange txn fee  — NSE: 0.00297% (cash), 0.053% (F&O options), 0.002% (futures)
 *   • SEBI turnover fee — 0.0001% on turnover
 *   • GST               — 18% on (brokerage + exchange fee)
 *   • Stamp duty        — 0.003% on buy side (max ₹1,500 per order)
 *
 * All rates as of 2024–2025. Pass a custom `CommissionConfig` to override.
 *
 * Usage
 * ─────
 *   const cost = nseCommission(fillPrice, qty, lotSize, "FO_OPTIONS");
 */

// ── Commission config ─────────────────────────────────────────────────────────

export type InstrumentSegment =
  | "EQ_INTRADAY"    // Equity intraday (MIS/BO/CO)
  | "EQ_DELIVERY"    // Equity delivery (CNC)
  | "FO_FUTURES"     // F&O futures
  | "FO_OPTIONS";    // F&O options (premium-based turnover)

export interface CommissionConfig {
  /** Flat brokerage per order leg (INR). Default: 20. */
  brokeragePerOrder: number;
  /** STT rate for F&O sell leg. Default: 0.000625 (0.0625%). */
  sttFoSell: number;
  /** STT rate for equity intraday sell. Default: 0.0025 (0.025%). */
  sttEqIntraday: number;
  /** STT rate for equity delivery (both legs). Default: 0.001 (0.1%). */
  sttEqDelivery: number;
  /** NSE exchange txn fee — cash. Default: 0.0000297. */
  exchFeeCash: number;
  /** NSE exchange txn fee — F&O futures. Default: 0.000002 (0.0002%). */
  exchFeeFutures: number;
  /** NSE exchange txn fee — F&O options. Default: 0.00053 (0.053%). */
  exchFeeOptions: number;
  /** SEBI turnover fee. Default: 0.000001 (0.0001%). */
  sebiFee: number;
  /** GST rate on brokerage + exchange fees. Default: 0.18. */
  gstRate: number;
  /** Stamp duty on buy side. Default: 0.00003 (0.003%). */
  stampDutyRate: number;
  /** Max stamp duty per order (INR). Default: 1500. */
  stampDutyMax: number;
}

export const DEFAULT_COMMISSION_CONFIG: CommissionConfig = {
  brokeragePerOrder: 20,
  sttFoSell: 0.000625,
  sttEqIntraday: 0.0025,
  sttEqDelivery: 0.001,
  exchFeeCash: 0.0000297,
  exchFeeFutures: 0.000002,
  exchFeeOptions: 0.00053,
  sebiFee: 0.000001,
  gstRate: 0.18,
  stampDutyRate: 0.00003,
  stampDutyMax: 1500,
};

// ── Commission calculation ────────────────────────────────────────────────────

export interface CommissionBreakdown {
  brokerage: number;
  stt: number;
  exchangeFee: number;
  sebiFee: number;
  gst: number;
  stampDuty: number;
  total: number;
}

/**
 * Calculate total commission for one order leg (buy OR sell).
 *
 * @param price      Fill price in INR
 * @param qty        Lots (F&O) or shares (equity)
 * @param lotSize    Lot size (1 for equity)
 * @param segment    Instrument segment (default: FO_OPTIONS)
 * @param isBuy      True for buy legs (stamp duty applies)
 * @param config     Override commission rates
 */
export function calcCommission(
  price: number,
  qty: number,
  lotSize: number,
  segment: InstrumentSegment = "FO_OPTIONS",
  isBuy = true,
  config: CommissionConfig = DEFAULT_COMMISSION_CONFIG,
): CommissionBreakdown {
  const turnover = price * qty * lotSize;

  // Brokerage: flat per order, capped at 2.5% of turnover for small orders
  const brokerage = Math.min(config.brokeragePerOrder, turnover * 0.025);

  // STT
  let stt = 0;
  if (segment === "FO_OPTIONS") {
    if (!isBuy) stt = turnover * config.sttFoSell;
  } else if (segment === "FO_FUTURES") {
    if (!isBuy) stt = turnover * config.sttFoSell * 0.1; // futures STT: 0.0125% sell side
  } else if (segment === "EQ_INTRADAY") {
    if (!isBuy) stt = turnover * config.sttEqIntraday;
  } else if (segment === "EQ_DELIVERY") {
    stt = turnover * config.sttEqDelivery;
  }

  // Exchange transaction fee
  let exchFee = 0;
  if (segment === "FO_OPTIONS") {
    exchFee = turnover * config.exchFeeOptions;
  } else if (segment === "FO_FUTURES") {
    exchFee = turnover * config.exchFeeFutures;
  } else {
    exchFee = turnover * config.exchFeeCash;
  }

  // SEBI turnover fee
  const sebiFee = turnover * config.sebiFee;

  // GST on brokerage + exchange fee
  const gst = (brokerage + exchFee) * config.gstRate;

  // Stamp duty — buy side only
  const stampDuty = isBuy
    ? Math.min(turnover * config.stampDutyRate, config.stampDutyMax)
    : 0;

  const total = brokerage + stt + exchFee + sebiFee + gst + stampDuty;

  return { brokerage, stt, exchangeFee: exchFee, sebiFee, gst, stampDuty, total };
}

/**
 * Shorthand: total commission for one leg of an NSE F&O trade.
 * Used by the engine's force-close path.
 */
export function nseCommission(
  price: number,
  qty: number,
  lotSize: number,
  segment: InstrumentSegment = "FO_OPTIONS",
  isBuy = false,
): number {
  return calcCommission(price, qty, lotSize, segment, isBuy).total;
}

// ── CommissionModel class (usable via dependency injection) ───────────────────

export class CommissionModel {
  private readonly config: CommissionConfig;

  constructor(config: Partial<CommissionConfig> = {}) {
    this.config = { ...DEFAULT_COMMISSION_CONFIG, ...config };
  }

  calc(
    price: number,
    qty: number,
    lotSize: number,
    segment: InstrumentSegment = "FO_OPTIONS",
    isBuy = true,
  ): CommissionBreakdown {
    return calcCommission(price, qty, lotSize, segment, isBuy, this.config);
  }

  total(
    price: number,
    qty: number,
    lotSize: number,
    segment: InstrumentSegment = "FO_OPTIONS",
    isBuy = true,
  ): number {
    return this.calc(price, qty, lotSize, segment, isBuy).total;
  }

  /** Convenience: total commission for both legs of a round-trip. */
  roundTrip(
    entryPrice: number,
    exitPrice: number,
    qty: number,
    lotSize: number,
    segment: InstrumentSegment = "FO_OPTIONS",
  ): number {
    return (
      this.total(entryPrice, qty, lotSize, segment, true) +
      this.total(exitPrice, qty, lotSize, segment, false)
    );
  }
}
