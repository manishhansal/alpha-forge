/**
 * Slippage model — simulates the cost of market impact and bid/ask spread.
 *
 * Three models are provided:
 *
 *  1. FixedBpsSlippage   — fixed basis points regardless of order size
 *  2. VolumeImpactModel  — slippage grows with order size relative to bar volume
 *  3. SpreadSlippage     — half-spread charge based on typical NSE bid/ask
 *
 * NSE defaults
 * ────────────
 * NSE F&O options typically have a spread of 0.1–0.5% of premium.
 * NSE futures are tighter: 0.02–0.05% of price.
 * Cash equities (large-cap): 0.01–0.05%.
 *
 * The default config uses 5 bps (0.05%) fixed, which is conservative for
 * NIFTY/BANKNIFTY futures and aggressive for deep OTM options.
 */

// ── Slippage config ───────────────────────────────────────────────────────────

export interface SlippageConfig {
  /** Model to use. Default: "FIXED_BPS". */
  model: "FIXED_BPS" | "VOLUME_IMPACT" | "SPREAD" | "ZERO";
  /** Fixed slippage in basis points (1 bps = 0.01%). Default: 5. */
  fixedBps: number;
  /**
   * Volume impact coefficient. Slippage = coefficient × (qty × lotSize) / barVolume.
   * Default: 0.1 (10% of order/volume ratio as slippage).
   */
  volumeImpactCoeff: number;
  /** Spread as fraction of price (half-spread per leg). Default: 0.0005. */
  spreadFraction: number;
  /** Maximum slippage as fraction of price (safety cap). Default: 0.02 (2%). */
  maxSlippageFraction: number;
}

export const DEFAULT_SLIPPAGE_CONFIG: SlippageConfig = {
  model: "FIXED_BPS",
  fixedBps: 5,
  volumeImpactCoeff: 0.1,
  spreadFraction: 0.0005,
  maxSlippageFraction: 0.02,
};

export const ZERO_SLIPPAGE_CONFIG: SlippageConfig = {
  model: "ZERO",
  fixedBps: 0,
  volumeImpactCoeff: 0,
  spreadFraction: 0,
  maxSlippageFraction: 0,
};

// ── SlippageModel ─────────────────────────────────────────────────────────────

export interface SlippageResult {
  /** Price after slippage is applied. */
  slippedPrice: number;
  /** Slippage amount in price units (always non-negative). */
  slippageAmount: number;
  /** Slippage as fraction of ideal price. */
  slippageFraction: number;
}

export class SlippageModel {
  private readonly config: SlippageConfig;

  constructor(config: Partial<SlippageConfig> = {}) {
    this.config = { ...DEFAULT_SLIPPAGE_CONFIG, ...config };
  }

  /**
   * Apply slippage to an ideal price.
   *
   * @param idealPrice  The intended fill price (e.g. bar open)
   * @param side        "BUY" adds slippage (price goes up); "SELL" subtracts it
   * @param qty         Order quantity (lots / shares)
   * @param lotSize     Lot size (1 for equity)
   * @param barVolume   Bar volume (needed only for VOLUME_IMPACT model)
   */
  apply(
    idealPrice: number,
    side: "BUY" | "SELL",
    qty: number,
    lotSize: number,
    barVolume?: number,
  ): SlippageResult {
    if (this.config.model === "ZERO") {
      return { slippedPrice: idealPrice, slippageAmount: 0, slippageFraction: 0 };
    }

    let slippageFraction: number;

    switch (this.config.model) {
      case "FIXED_BPS":
        slippageFraction = this.config.fixedBps / 10_000;
        break;

      case "VOLUME_IMPACT": {
        const orderSize = qty * lotSize;
        const volume = barVolume ?? orderSize * 100; // fallback: assume large liquidity
        slippageFraction = volume > 0
          ? this.config.volumeImpactCoeff * (orderSize / volume)
          : this.config.fixedBps / 10_000;
        break;
      }

      case "SPREAD":
        slippageFraction = this.config.spreadFraction;
        break;

      default:
        slippageFraction = this.config.fixedBps / 10_000;
    }

    // Cap at maxSlippageFraction
    slippageFraction = Math.min(slippageFraction, this.config.maxSlippageFraction);

    const slippageAmount = idealPrice * slippageFraction;
    // Buys pay more; sells receive less
    const slippedPrice =
      side === "BUY"
        ? idealPrice + slippageAmount
        : idealPrice - slippageAmount;

    return { slippedPrice, slippageAmount, slippageFraction };
  }
}
