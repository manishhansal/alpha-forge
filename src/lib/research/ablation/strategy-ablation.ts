/**
 * Phase 15 — Strategy Ablation Testing
 *
 * Every complex strategy must support component ablation to identify
 * which components actually contribute to OOS performance.
 *
 * If removing a component does not degrade OOS performance:
 *   → mark LOW_VALUE_COMPONENT
 *   → the component adds complexity without evidence of value
 *
 * Ablation is run on the FINAL_OOS period only.
 * In-sample ablation is meaningless (the model was tuned with the components).
 */

import type {
  AblationComponent,
  AblationResult,
  PerformanceMetrics,
} from "../types";
import type { AnalyzerTrade } from "../performance/strategy-performance-analyzer";
import { computePerformanceMetrics } from "../performance/strategy-performance-analyzer";

// ─── Ablation Trade ───────────────────────────────────────────────────────────

/**
 * Trade record with component flags.
 * Each component flag is true when that component contributed to the signal.
 */
export interface AblationTrade extends AnalyzerTrade {
  componentFlags: Record<string, boolean>;
}

// ─── Ablation Runner ──────────────────────────────────────────────────────────

/**
 * Run ablation analysis for a single component.
 *
 * "Without component" simulation:
 *   Trades are filtered to only those that would have fired WITHOUT the
 *   component (i.e. componentFlags[componentName] === false).
 *
 * Note: this is a conservative simulation. A more accurate simulation
 * would re-run the full strategy logic with the component disabled.
 * Use the re-run approach when possible.
 */
export function ablateComponent(
  componentName: string,
  description: string,
  allTrades: AblationTrade[],
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): AblationComponent {
  // Full strategy performance
  const withMetrics = computePerformanceMetrics(
    allTrades,
    "FINAL_OOS",
    annualFactor,
    riskFreeRate,
  );

  // Without component: trades that fired even when this component was absent
  // (i.e. trades where the component was NOT the deciding factor)
  const withoutComponentTrades = allTrades.filter(
    (t) => !t.componentFlags[componentName],
  );

  let withoutMetrics: PerformanceMetrics;
  if (withoutComponentTrades.length >= 10) {
    withoutMetrics = computePerformanceMetrics(
      withoutComponentTrades,
      "FINAL_OOS",
      annualFactor,
      riskFreeRate,
    );
  } else {
    // Insufficient trades without component — assume same performance
    withoutMetrics = { ...withMetrics };
  }

  const sharpeImpact = withMetrics.sharpe - withoutMetrics.sharpe;
  const expectancyImpact = withMetrics.expectancy - withoutMetrics.expectancy;
  const winRateImpact = withMetrics.winRate - withoutMetrics.winRate;

  // LOW_VALUE_COMPONENT: removing it doesn't hurt (sharpe impact <= 0.05 improvement)
  const lowValueComponent =
    sharpeImpact <= 0.05 && expectancyImpact <= 0.001;

  return {
    componentName,
    description,
    withComponent: withMetrics,
    withoutComponent: withoutMetrics,
    sharpeImpact,
    expectancyImpact,
    winRateImpact,
    lowValueComponent,
  };
}

/**
 * Run ablation for all components of a strategy.
 */
export function runStrategyAblation(
  strategyId: string,
  trades: AblationTrade[],
  componentDescriptions: Record<string, string>,
  annualFactor: number = 252,
  riskFreeRate: number = 0.065,
): AblationResult {
  const componentNames = Object.keys(componentDescriptions);
  const components: AblationComponent[] = componentNames.map((name) =>
    ablateComponent(
      name,
      componentDescriptions[name],
      trades,
      annualFactor,
      riskFreeRate,
    ),
  );

  return {
    strategyId,
    components,
    computedAt: new Date().toISOString(),
  };
}

// ─── Strategy Component Definitions ──────────────────────────────────────────
// Canonical component lists for each strategy in the registry.

export const STRATEGY_COMPONENT_DESCRIPTIONS: Record<string, Record<string, string>> = {
  UT_SMC: {
    utBot: "UT Bot ATR trailing stop flip signal",
    smcBias: "SMC BOS/CHoCH structural pivot context",
    atrFilter: "ATR minimum range filter (avoid flat markets)",
  },
  VWAP_SWEEP_TREND: {
    trendFilter: "Higher-timeframe EMA50 trend direction filter",
    vwapDeviation: "Minimum VWAP deviation requirement (0.8×ATR)",
    sweepConfirmation: "Prior swing swept before entry",
  },
  NEWS_MOMENTUM: {
    volumeFilter: "Volume ≥2.8× average filter",
    rangeFilter: "Bar range ≥1.8×ATR filter",
    trendBias: "SMA20 direction bias filter",
  },
  RANGE_SCALP: {
    bbWidth: "Bollinger Band width contraction filter (range-bound gate)",
    rsiExtreme: "RSI ≤32 or ≥68 extreme filter",
    flatMidband: "Flat midband filter (avoids trending markets)",
  },
  EMA_PULLBACK: {
    emaStack: "EMA9 > EMA20 > EMA50 bull/bear stack",
    slopeFilter: "Rising/falling EMA slope filter",
    pullbackZone: "Pullback into EMA9-20 zone requirement",
  },
  VWAP_REVERSION: {
    vwapExtension: "Price ≥1.5×ATR from VWAP requirement",
    rsiExtreme: "RSI extreme (≤30 or ≥70) filter",
    momentumWeakening: "Prior bar more extreme than current (momentum weakening)",
  },
  ORDERFLOW_SWEEP: {
    equalLevels: "Equal swing highs/lows cluster identification",
    volumeFilter: "Volume ≥1.8× average on sweep bar",
    closeConfirmation: "Close back inside range after wick",
  },
  FIB_PULLBACK: {
    impulseDetection: "Impulse ≥3×ATR detection",
    fibZone: "0.5-0.618 Fibonacci retracement zone",
    confirmationCandle: "Confirmation candle closing above 0.5 Fib",
  },
  INSTITUTIONAL_SMC: {
    smcScore: "9-component SMC AI score (threshold 7/9)",
    trendPrecondition: "EMA20/50 trend precondition",
    vwapPrecondition: "VWAP side precondition",
    sweepPrecondition: "Recent liquidity sweep precondition",
    bosPrecondition: "Recent BOS precondition",
  },
  AI_INSTITUTIONAL_PRO: {
    hardGates: "Hard gates (EMA trend + HTF bias + RSI + cooldown)",
    confluenceScore: "8-factor confluence score",
    modePreset: "Mode-adaptive threshold (scalp vs intraday)",
    cooldown: "Per-direction cooldown rate-limiter",
  },
  FNO_TREND: {
    adxFilter: "ADX > 20 and DI+ > DI− filter",
    macdFilter: "MACD above zero and above signal",
    smaStack: "SMA20 > SMA40 bull stack",
    volumeFilter: "Volume > 1L filter",
    rsiFilter: "RSI > 50 filter",
  },
  FNO_RANGE_EXPANSION: {
    rangeMultiple: "Range ≥1.2× prior 7-bar max range",
    volumeFilter: "Volume ≥1.5× 20-day average",
    smaStack: "SMA20 > SMA50 > SMA200 bull stack",
    weekMonthFilter: "Close above week and month open",
  },
  INDIA_AI_SIGNALS: {
    mlRankBoost: "ML stock ranker confidence boost/penalty",
    superConfluence: "Super confluence indicator score",
    oiBuildup: "OI build-up direction factor (weight 0.10)",
    maxPainPull: "Max-pain pull factor (weight 0.05)",
    scannerAgreement: "Scanner agreement factor (weight 0.10)",
    quantPrefilter: "Quant pre-filter (ADX ≥18, relVol ≥1.1, ATR% ≥0.4)",
  },
};
