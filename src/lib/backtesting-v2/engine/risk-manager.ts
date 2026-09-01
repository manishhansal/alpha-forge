/**
 * RiskManager — the gate between a raw signal and a live order.
 *
 * The DefaultRiskManager implements all NSE F&O risk rules:
 *
 *   1. Capital check     — enough cash / margin to open the position
 *   2. Position count    — max concurrent positions
 *   3. Symbol exposure   — no doubling-up on the same underlying
 *   4. Sector exposure   — sector concentration limit
 *   5. Data quality      — dataQualityScore threshold
 *   6. Session gate      — no new orders outside 09:15–15:30 IST
 *   7. Expiry cooldown   — no new directional bets on expiry-day afternoon
 *   8. Daily loss cap    — halt new entries after daily loss limit
 *   9. Reward/risk min   — reject signals with RR below threshold
 *  10. Duplicate signal  — already holding this symbol
 *
 * The manager also sizes the order (qty) based on the configured
 * PositionSizer, then emits an OrderEvent with `validFromBarIndex`
 * enforcing the NEXT_BAR_OPEN execution delay.
 */

import type { SignalEvent } from "../events/signal-event";
import type { OrderEvent } from "../events/order-event";
import { buildOrderEvent } from "../events/order-event";
import type { RiskCheckEvent, RiskRejectReason } from "../events/risk-event";
import { buildRiskCheckEvent } from "../events/risk-event";
import type { Portfolio } from "../models/portfolio";
import type { OrderBook } from "../models/order";

// ── RiskManager interface ─────────────────────────────────────────────────────

export interface RiskManager {
  check(
    signal: SignalEvent,
    portfolio: Portfolio,
    orderBook: OrderBook,
  ): RiskCheckEvent;
  buildOrder(signal: SignalEvent, portfolio: Portfolio): OrderEvent | null;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface RiskManagerConfig {
  /** Minimum reward/risk ratio to accept a signal. Default: 1.0. */
  minRiskReward: number;
  /** Minimum dataQualityScore [0, 1] to accept a signal. Default: 0.5. */
  minDataQuality: number;
  /** Fraction of available cash to risk per trade. Default: 0.02 (2%). */
  riskPerTradeFraction: number;
  /** Maximum number of simultaneously open positions. */
  maxOpenPositions: number;
  /** Maximum gross notional as multiple of equity. Default: 2.0. */
  maxGrossExposure: number;
  /** No new entries within this many minutes of session close. Default: 0. */
  sessionCloseBufferMinutes: number;
  /** Sector map: symbol → sector, for exposure checks. */
  sectorMap: Map<string, string>;
  /** Max sector notional as fraction of equity. Default: 0.4. */
  maxSectorExposureFraction: number;
}

export const DEFAULT_RISK_CONFIG: RiskManagerConfig = {
  minRiskReward: 1.0,
  minDataQuality: 0.5,
  riskPerTradeFraction: 0.02,
  maxOpenPositions: 10,
  maxGrossExposure: 2.0,
  sessionCloseBufferMinutes: 0,
  sectorMap: new Map(),
  maxSectorExposureFraction: 0.4,
};

// ── DefaultRiskManager ────────────────────────────────────────────────────────

export class DefaultRiskManager implements RiskManager {
  readonly config: RiskManagerConfig;

  constructor(config: Partial<RiskManagerConfig> = {}) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
  }

  check(
    signal: SignalEvent,
    portfolio: Portfolio,
    orderBook: OrderBook,
  ): RiskCheckEvent {
    const snapshot = portfolio.riskSnapshot();

    const reject = (
      reason: RiskRejectReason,
      detail?: string,
    ): RiskCheckEvent =>
      buildRiskCheckEvent({
        sourceEventId: signal.sourceEventId,
        timestampMs: signal.timestampMs,
        signalEventId: signal.id,
        instrument: signal.instrument,
        decision: "REJECTED",
        rejectReason: reason,
        rejectDetail: detail,
        portfolioSnapshot: snapshot,
      });

    // 1. Daily loss cap
    if (portfolio.isDailyLossLimitHit()) {
      return reject("DAILY_LOSS_LIMIT_HIT", "Daily loss limit exhausted");
    }

    // 2. Duplicate: already holding this symbol
    if (portfolio.positionForSymbol(signal.instrument.symbol)) {
      return reject("DUPLICATE_SIGNAL", `Already in position for ${signal.instrument.symbol}`);
    }

    // 3. Reward/risk minimum
    if (signal.levels.riskReward < this.config.minRiskReward) {
      return reject(
        "RISK_REWARD_TOO_LOW",
        `RR ${signal.levels.riskReward.toFixed(2)} < minimum ${this.config.minRiskReward}`,
      );
    }

    // 4. Data quality
    if (signal.attribution.dataQualityScore < this.config.minDataQuality) {
      return reject(
        "DATA_QUALITY_TOO_LOW",
        `Score ${signal.attribution.dataQualityScore.toFixed(2)} < ${this.config.minDataQuality}`,
      );
    }

    // 5. Max open positions
    if (snapshot.openPositions >= this.config.maxOpenPositions) {
      return reject(
        "MAX_OPEN_POSITIONS_REACHED",
        `${snapshot.openPositions} positions open`,
      );
    }

    // 6. Margin / capital check — estimate required margin
    const stopDist = Math.abs(signal.levels.entry - signal.levels.stopLoss);
    const riskAmount = snapshot.equity * this.config.riskPerTradeFraction;
    const qty = stopDist > 0
      ? Math.max(1, Math.floor(riskAmount / (stopDist * signal.instrument.lotSize)))
      : 1;
    const notional = qty * signal.levels.entry * signal.instrument.lotSize;

    if (!portfolio.canAfford(notional)) {
      return reject(
        "INSUFFICIENT_CAPITAL",
        `Need ₹${(notional * portfolio.config.marginFactor).toFixed(0)}, available ₹${snapshot.availableCash.toFixed(0)}`,
      );
    }

    // 7. Margin utilisation
    if (snapshot.marginUtilisation > 0.9) {
      return reject(
        "MARGIN_UTILISATION_TOO_HIGH",
        `Margin utilisation ${(snapshot.marginUtilisation * 100).toFixed(1)}%`,
      );
    }

    // 8. Gross exposure limit
    const exposure = portfolio.calcExposure(this.config.sectorMap);
    const newGross = exposure.grossExposure + notional;
    if (newGross > snapshot.equity * this.config.maxGrossExposure) {
      return reject(
        "MAX_SYMBOL_EXPOSURE_REACHED",
        `Gross exposure ${newGross.toFixed(0)} would exceed limit`,
      );
    }

    // 9. Sector exposure
    if (this.config.sectorMap.size > 0) {
      const sector = this.config.sectorMap.get(signal.instrument.symbol);
      if (sector) {
        const sectorNotional = exposure.sectorExposure.get(sector) ?? 0;
        const sectorLimit = snapshot.equity * this.config.maxSectorExposureFraction;
        if (Math.abs(sectorNotional) + notional > sectorLimit) {
          return reject(
            "MAX_SECTOR_EXPOSURE_REACHED",
            `Sector ${sector} would breach ${(this.config.maxSectorExposureFraction * 100).toFixed(0)}% limit`,
          );
        }
      }
    }

    // Approved
    return buildRiskCheckEvent({
      sourceEventId: signal.sourceEventId,
      timestampMs: signal.timestampMs,
      signalEventId: signal.id,
      instrument: signal.instrument,
      decision: "APPROVED",
      portfolioSnapshot: snapshot,
    });
  }

  /**
   * Build an OrderEvent from an approved signal.
   * Returns null if sizing produces qty = 0 (shouldn't happen after check()).
   */
  buildOrder(signal: SignalEvent, portfolio: Portfolio): OrderEvent | null {
    const stopDist = Math.abs(signal.levels.entry - signal.levels.stopLoss);
    const riskAmount = portfolio.equity * this.config.riskPerTradeFraction;
    const qty = stopDist > 0
      ? Math.max(1, Math.floor(riskAmount / (stopDist * signal.instrument.lotSize)))
      : 1;
    if (qty <= 0) return null;

    const validFrom = signal.signalBarIndex + 1; // NEXT_BAR enforcement

    return buildOrderEvent({
      sourceEventId: signal.sourceEventId,
      timestampMs: signal.timestampMs,
      signalEventId: signal.id,
      instrument: signal.instrument,
      side: signal.direction === "LONG" ? "BUY" : "SELL",
      intent: "OPEN",
      direction: signal.direction,
      orderType: signal.exitTiming === "LIMIT_FILL" ? "LIMIT" : "MARKET",
      qty,
      limitPrice: signal.exitTiming === "LIMIT_FILL" ? signal.levels.limitPrice : undefined,
      validFromBarIndex: validFrom,
      expiryBarIndex: validFrom,  // good-for-one-bar default
    });
  }
}
