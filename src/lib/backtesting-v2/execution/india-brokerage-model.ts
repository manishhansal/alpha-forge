/**
 * india-brokerage-model.ts — Configurable Indian brokerage cost models.
 *
 * Covers all cost components charged by Indian brokers / NSE:
 *   • Brokerage        — per-order flat fee or percentage, capped per NSE rules
 *   • STT              — Securities Transaction Tax (different rates by segment)
 *   • Exchange charges — NSE transaction fee (different rates by segment)
 *   • GST              — 18% on (brokerage + exchange charges)
 *   • SEBI charges     — 0.0001% on turnover
 *   • Stamp duty       — 0.003% on buy side, capped at ₹1,500 per order
 *   • DP charges       — ₹15.34 per scrip per day for equity delivery (optional)
 *
 * Pre-built profiles:
 *   IndiaBrokerageModel.zerodha()  — Zerodha/Upstox flat-fee model (₹20 F&O, free EQ delivery)
 *   IndiaBrokerageModel.fullService() — Old-school % brokerage (0.3% cash, ₹50 F&O)
 *   IndiaBrokerageModel.discount()    — Ultra-discount (₹15 flat all segments)
 *
 * All monetary values in INR.
 */

// ── Segment classification ────────────────────────────────────────────────────

export type IndiaSegment =
  | "EQ_DELIVERY"    // Cash equity held overnight (CNC)
  | "EQ_INTRADAY"    // Cash equity intraday (MIS/BO)
  | "FO_FUTURES"     // F&O futures (BNF, NIFTY, stock futures)
  | "FO_OPTIONS";    // F&O options (premium-based turnover)

// ── Rates config ──────────────────────────────────────────────────────────────

export interface IndiaBrokerageConfig {
  /** Flat brokerage per order leg (INR). 0 = no flat fee. */
  flatBrokeragePerOrder: number;

  /**
   * Percentage brokerage on turnover (0.003 = 0.3%).
   * Applied ONLY if > 0; result is capped at `maxBrokerageCap`.
   * For Zerodha-style brokers set this to 0 (flat-only model).
   */
  brokeragePct: number;

  /** Max brokerage per order leg when using % model (INR). Default: 20. */
  maxBrokerageCap: number;

  // STT rates (fractions, not percentages)
  /** STT on equity delivery — both buy and sell. Default: 0.001 (0.1%). */
  sttEqDelivery: number;
  /** STT on equity intraday — sell side only. Default: 0.00025 (0.025%). */
  sttEqIntraday: number;
  /** STT on F&O options — sell side only. Default: 0.000625 (0.0625%). */
  sttFoOptions: number;
  /** STT on F&O futures — sell side only. Default: 0.0000125 (0.00125%). */
  sttFoFutures: number;

  // Exchange transaction charges (fractions)
  /** NSE charge — equity cash segment. Default: 0.0000297 (0.00297%). */
  nseChargeEq: number;
  /** NSE charge — F&O futures. Default: 0.000002 (0.0002%). */
  nseChargeFutures: number;
  /** NSE charge — F&O options. Default: 0.00053 (0.053%). */
  nseChargeOptions: number;

  /** SEBI turnover fee (fraction). Default: 0.000001 (0.0001%). */
  sebiFee: number;

  /** GST rate on (brokerage + exchange charges). Default: 0.18 (18%). */
  gstRate: number;

  /** Stamp duty rate on buy side (fraction). Default: 0.00003 (0.003%). */
  stampDutyRate: number;

  /** Max stamp duty per order (INR). Default: 1500. */
  stampDutyMax: number;

  /**
   * DP (Depository Participant) charge per scrip per day on equity delivery.
   * Charged on sell side only. Default: 15.34 (CDSL/NSDL typical).
   * Set 0 to disable.
   */
  dpChargePerScrip: number;
}

export const ZERODHA_CONFIG: IndiaBrokerageConfig = {
  flatBrokeragePerOrder: 20,
  brokeragePct: 0,
  maxBrokerageCap: 20,
  sttEqDelivery: 0.001,
  sttEqIntraday: 0.00025,
  sttFoOptions: 0.000625,
  sttFoFutures: 0.0000125,
  nseChargeEq: 0.0000297,
  nseChargeFutures: 0.000002,
  nseChargeOptions: 0.00053,
  sebiFee: 0.000001,
  gstRate: 0.18,
  stampDutyRate: 0.00003,
  stampDutyMax: 1500,
  dpChargePerScrip: 15.34,
};

export const FULL_SERVICE_CONFIG: IndiaBrokerageConfig = {
  flatBrokeragePerOrder: 0,
  brokeragePct: 0.003,        // 0.3% for cash; capped below for F&O
  maxBrokerageCap: 50,        // ₹50 cap per leg for F&O
  sttEqDelivery: 0.001,
  sttEqIntraday: 0.00025,
  sttFoOptions: 0.000625,
  sttFoFutures: 0.0000125,
  nseChargeEq: 0.0000297,
  nseChargeFutures: 0.000002,
  nseChargeOptions: 0.00053,
  sebiFee: 0.000001,
  gstRate: 0.18,
  stampDutyRate: 0.00003,
  stampDutyMax: 1500,
  dpChargePerScrip: 15.34,
};

export const DISCOUNT_CONFIG: IndiaBrokerageConfig = {
  flatBrokeragePerOrder: 15,
  brokeragePct: 0,
  maxBrokerageCap: 15,
  sttEqDelivery: 0.001,
  sttEqIntraday: 0.00025,
  sttFoOptions: 0.000625,
  sttFoFutures: 0.0000125,
  nseChargeEq: 0.0000297,
  nseChargeFutures: 0.000002,
  nseChargeOptions: 0.00053,
  sebiFee: 0.000001,
  gstRate: 0.18,
  stampDutyRate: 0.00003,
  stampDutyMax: 1500,
  dpChargePerScrip: 0,
};

// ── Cost breakdown ────────────────────────────────────────────────────────────

export interface IndiaCostBreakdown {
  /** Brokerage charged (flat or % of turnover). */
  brokerage: number;
  /** Securities Transaction Tax. */
  stt: number;
  /** NSE exchange transaction charge. */
  exchangeCharge: number;
  /** SEBI turnover fee. */
  sebiFee: number;
  /** GST on brokerage + exchange charges. */
  gst: number;
  /** Stamp duty (buy side). */
  stampDuty: number;
  /** DP charge (equity delivery sell side). */
  dpCharge: number;
  /** Sum of all components. */
  total: number;
  /** Effective cost as fraction of turnover. */
  effectiveCostFraction: number;
}

// ── Calculator ────────────────────────────────────────────────────────────────

export class IndiaBrokerageModel {
  readonly config: IndiaBrokerageConfig;

  constructor(config: Partial<IndiaBrokerageConfig> = {}) {
    this.config = { ...ZERODHA_CONFIG, ...config };
  }

  /**
   * Calculate the full cost breakdown for one order leg.
   *
   * @param fillPrice  Actual fill price in INR
   * @param qty        Lots (F&O) or shares (equity)
   * @param lotSize    Lot size (1 for equity)
   * @param segment    Instrument segment
   * @param isBuy      True for buy legs
   */
  calc(
    fillPrice: number,
    qty: number,
    lotSize: number,
    segment: IndiaSegment,
    isBuy: boolean,
  ): IndiaCostBreakdown {
    const turnover = fillPrice * qty * lotSize;
    const c = this.config;

    // ── Brokerage ─────────────────────────────────────────────────────────
    let brokerage: number;
    if (c.flatBrokeragePerOrder > 0) {
      // Flat model: flat fee, capped at 2.5% for tiny orders
      brokerage = Math.min(c.flatBrokeragePerOrder, turnover * 0.025);
    } else if (c.brokeragePct > 0) {
      // Percentage model, capped
      brokerage = Math.min(c.brokeragePct * turnover, c.maxBrokerageCap);
    } else {
      brokerage = 0;
    }
    // Equity delivery: Zerodha charges ₹0 for delivery
    if (segment === "EQ_DELIVERY" && c.flatBrokeragePerOrder === 20) {
      brokerage = 0; // free delivery brokerage for Zerodha-style brokers
    }

    // ── STT ──────────────────────────────────────────────────────────────
    let stt = 0;
    switch (segment) {
      case "EQ_DELIVERY":
        // Both sides taxed at 0.1%
        stt = turnover * c.sttEqDelivery;
        break;
      case "EQ_INTRADAY":
        if (!isBuy) stt = turnover * c.sttEqIntraday;
        break;
      case "FO_FUTURES":
        if (!isBuy) stt = turnover * c.sttFoFutures;
        break;
      case "FO_OPTIONS":
        if (!isBuy) stt = turnover * c.sttFoOptions;
        break;
    }

    // ── Exchange transaction charge ───────────────────────────────────────
    let exchangeCharge = 0;
    switch (segment) {
      case "EQ_DELIVERY":
      case "EQ_INTRADAY":
        exchangeCharge = turnover * c.nseChargeEq;
        break;
      case "FO_FUTURES":
        exchangeCharge = turnover * c.nseChargeFutures;
        break;
      case "FO_OPTIONS":
        exchangeCharge = turnover * c.nseChargeOptions;
        break;
    }

    // ── SEBI fee ─────────────────────────────────────────────────────────
    const sebiFee = turnover * c.sebiFee;

    // ── GST ──────────────────────────────────────────────────────────────
    const gst = (brokerage + exchangeCharge) * c.gstRate;

    // ── Stamp duty (buy side only) ────────────────────────────────────────
    const stampDuty = isBuy
      ? Math.min(turnover * c.stampDutyRate, c.stampDutyMax)
      : 0;

    // ── DP charge (equity delivery sell side) ────────────────────────────
    const dpCharge =
      segment === "EQ_DELIVERY" && !isBuy ? c.dpChargePerScrip : 0;

    const total = brokerage + stt + exchangeCharge + sebiFee + gst + stampDuty + dpCharge;
    const effectiveCostFraction = turnover > 0 ? total / turnover : 0;

    return {
      brokerage,
      stt,
      exchangeCharge,
      sebiFee,
      gst,
      stampDuty,
      dpCharge,
      total,
      effectiveCostFraction,
    };
  }

  /** Convenience: total cost (single number) for one order leg. */
  total(
    fillPrice: number,
    qty: number,
    lotSize: number,
    segment: IndiaSegment,
    isBuy: boolean,
  ): number {
    return this.calc(fillPrice, qty, lotSize, segment, isBuy).total;
  }

  // ── Pre-built profiles ────────────────────────────────────────────────────

  /** Zerodha / Upstox discount-broker model (₹20 flat for F&O, free delivery). */
  static zerodha(): IndiaBrokerageModel {
    return new IndiaBrokerageModel(ZERODHA_CONFIG);
  }

  /** Traditional full-service broker (% brokerage). */
  static fullService(): IndiaBrokerageModel {
    return new IndiaBrokerageModel(FULL_SERVICE_CONFIG);
  }

  /** Ultra-discount (₹15 flat all segments). */
  static discount(): IndiaBrokerageModel {
    return new IndiaBrokerageModel(DISCOUNT_CONFIG);
  }
}

/**
 * Derive IndiaSegment from InstrumentType and isIntraday flag.
 * Convenience helper for use in fill models.
 */
export function toIndiaSegment(
  instrumentType: string,
  isIntraday = true,
): IndiaSegment {
  switch (instrumentType) {
    case "EQ":
      return isIntraday ? "EQ_INTRADAY" : "EQ_DELIVERY";
    case "FUTSTK":
    case "FUTIDX":
      return "FO_FUTURES";
    case "OPTSTK":
    case "OPTIDX":
      return "FO_OPTIONS";
    default:
      return "FO_OPTIONS";
  }
}
