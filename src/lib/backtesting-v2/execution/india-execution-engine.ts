/**
 * india-execution-engine.ts — Main facade for the Indian Market Execution
 * Simulation Engine.
 *
 * Composes:
 *   • IndiaFillModel      — MARKET / LIMIT / STOP_MARKET / STOP_LIMIT fills
 *                           with partial fills and execution quality tracking
 *   • IndiaSlippageModel  — instrument-aware, depth-based slippage
 *   • IndiaBrokerageModel — configurable NSE/NFO cost model
 *   • LatencyModel        — signal/network/order latency simulation
 *   • ExecutionQualityReporter — aggregate quality metrics
 *
 * Drop-in replacement for any FillModel used with EventEngine:
 *
 *   const engine = IndiaExecutionEngine.realistic();
 *   eventEngine.setFillModel(engine);
 *   const result = eventEngine.run(bars, instrument);
 *   const qualityReport = engine.buildQualityReport();
 *
 * Pre-built profiles:
 *   IndiaExecutionEngine.realistic()     — MEDIUM latency, Zerodha fees, market-depth slippage
 *   IndiaExecutionEngine.conservative()  — HIGH latency, full-service fees, wider spreads
 *   IndiaExecutionEngine.ideal()         — LOW latency, zero fees, zero slippage (test only)
 *   IndiaExecutionEngine.liquid()        — LARGE_CAP tier forced, narrow spreads
 *   IndiaExecutionEngine.illiquid()      — SMALL_CAP / DEEP_OTM tier, wide spreads, partial fills
 *
 * The engine implements FillModel, so it integrates without any changes to
 * EventEngine, RiskManager, or Portfolio.
 */

import type { OrderRecord } from "../models/order";
import type { OHLCVBar } from "../events/market-event";
import type { FillEvent } from "../events/fill-event";
import type { FillModel } from "./fill-model";
import { IndiaFillModel } from "./india-fill-model";
import type { IndiaFillModelConfig } from "./india-fill-model";
import { ExecutionQualityReporter } from "./execution-quality-report";
import type { ExecutionQualityReport } from "./execution-quality-report";
import type { LiquidityTier } from "./market-depth";
import type { LatencyProfileName } from "./latency-model";
import type { IndiaSlippageConfig } from "./india-slippage-model";
import { ZERODHA_CONFIG, FULL_SERVICE_CONFIG, DISCOUNT_CONFIG } from "./india-brokerage-model";

// ── Engine config ─────────────────────────────────────────────────────────────

export interface IndiaExecutionEngineConfig extends IndiaFillModelConfig {
  /**
   * Whether to record every fill in the quality reporter.
   * Default: true.
   */
  trackQuality?: boolean;
}

// ── IndiaExecutionEngine ──────────────────────────────────────────────────────

export class IndiaExecutionEngine implements FillModel {
  private readonly fillModel:  IndiaFillModel;
  private readonly reporter:   ExecutionQualityReporter;
  private readonly trackQuality: boolean;

  constructor(config: IndiaExecutionEngineConfig = {}) {
    const { trackQuality = true, ...fillConfig } = config;
    this.fillModel    = new IndiaFillModel(fillConfig);
    this.reporter     = new ExecutionQualityReporter();
    this.trackQuality = trackQuality;
  }

  // ── FillModel interface ──────────────────────────────────────────────────

  tryFill(
    order: OrderRecord,
    bar: OHLCVBar,
    barIndex: number,
    timestampMs: number,
  ): FillEvent | null {
    const fill = this.fillModel.tryFill(order, bar, barIndex, timestampMs);
    if (this.trackQuality) {
      if (fill) {
        this.reporter.record(fill);
      } else if (barIndex === order.expiryBarIndex) {
        // Order expired without fill (limit/stop never reached)
        this.reporter.recordUnfilled();
      }
    }
    return fill;
  }

  // ── Quality report ────────────────────────────────────────────────────────

  /**
   * Build and return the execution quality report for all fills recorded
   * since this engine was constructed.
   */
  buildQualityReport(): ExecutionQualityReport {
    return this.reporter.build();
  }

  // ── Static factory methods ────────────────────────────────────────────────

  /**
   * Realistic retail trading: MEDIUM latency, Zerodha fees, market-depth slippage.
   * Good default for most strategy backtests.
   */
  static realistic(): IndiaExecutionEngine {
    return new IndiaExecutionEngine({
      latency: "MEDIUM",
      brokerage: ZERODHA_CONFIG,
      slippage: { spreadMultiplier: 1.0 },
    });
  }

  /**
   * Conservative stress-test: HIGH latency, full-service fees, 1.5× spread.
   * Use to check strategy robustness under adverse execution conditions.
   */
  static conservative(): IndiaExecutionEngine {
    return new IndiaExecutionEngine({
      latency: "HIGH",
      brokerage: FULL_SERVICE_CONFIG,
      slippage: {
        spreadMultiplier: 1.5,
        impactCoeff: 0.2,
        atrMultiplier: 0.8,
      },
    });
  }

  /**
   * Ideal execution: LOW latency, zero brokerage, zero slippage.
   * Use ONLY for pure signal-quality testing — NOT realistic.
   */
  static ideal(): IndiaExecutionEngine {
    return new IndiaExecutionEngine({
      latency: "LOW",
      brokerage: {
        flatBrokeragePerOrder: 0,
        brokeragePct: 0,
        maxBrokerageCap: 0,
        sttEqDelivery: 0,
        sttEqIntraday: 0,
        sttFoOptions: 0,
        sttFoFutures: 0,
        nseChargeEq: 0,
        nseChargeFutures: 0,
        nseChargeOptions: 0,
        sebiFee: 0,
        gstRate: 0,
        stampDutyRate: 0,
        stampDutyMax: 0,
        dpChargePerScrip: 0,
      },
      slippage: {
        impactCoeff: 0,
        atrMultiplier: 0,
        atrThreshold: 1,
        optionOtmPenalty: { NTM_OPTION: 0, OTM_OPTION: 0, DEEP_OTM: 0 },
        maxSlippageFraction: 0,
        spreadMultiplier: 0,
      },
    });
  }

  /**
   * Liquid instrument profile: LARGE_CAP tier, narrow spreads.
   * Best for NIFTY50 stock or NIFTY/BANKNIFTY futures backtests.
   */
  static liquid(latency: LatencyProfileName = "MEDIUM"): IndiaExecutionEngine {
    return new IndiaExecutionEngine({
      latency,
      brokerage: ZERODHA_CONFIG,
      slippage: {
        spreadMultiplier: 0.8,  // tight spreads
        impactCoeff: 0.05,
        optionOtmPenalty: { NTM_OPTION: 0.002, OTM_OPTION: 0.005, DEEP_OTM: 0.015 },
      },
      partialFillThreshold: 0.05,  // almost always fully fillable
    });
  }

  /**
   * Illiquid instrument profile: wide spreads, low depth, frequent partial fills.
   * Use for small-cap equities or deep-OTM / low-OI options.
   */
  static illiquid(latency: LatencyProfileName = "HIGH"): IndiaExecutionEngine {
    return new IndiaExecutionEngine({
      latency,
      brokerage: ZERODHA_CONFIG,
      slippage: {
        spreadMultiplier: 3.0,  // very wide spreads
        impactCoeff: 0.3,
        atrMultiplier: 1.0,
        optionOtmPenalty: { NTM_OPTION: 0.02, OTM_OPTION: 0.05, DEEP_OTM: 0.10 },
        maxSlippageFraction: 0.08,
      },
      partialFillThreshold: 0.3,  // often partially filled
    });
  }

  /**
   * Options-focused profile: ATM options with realistic spreads.
   */
  static options(
    latency: LatencyProfileName = "MEDIUM",
    otmMultiplier = 1.0,
  ): IndiaExecutionEngine {
    return new IndiaExecutionEngine({
      latency,
      brokerage: ZERODHA_CONFIG,
      slippage: {
        spreadMultiplier: 1.0,
        optionOtmPenalty: {
          NTM_OPTION: 0.005 * otmMultiplier,
          OTM_OPTION: 0.015 * otmMultiplier,
          DEEP_OTM:   0.040 * otmMultiplier,
        },
      },
      partialFillThreshold: 0.15,
    });
  }
}
