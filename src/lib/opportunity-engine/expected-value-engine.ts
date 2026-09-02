/**
 * ExpectedValueEngine — Enhanced EV Calculation
 *
 * Provides a complete, cost-aware expected value for every opportunity.
 * This replaces the simple confidence ranking used by the current auto-trader.
 *
 * Core formula:
 *   EV = P(win) × E[win%] - P(loss) × E[loss%] - costs - slippage
 *
 * Key improvements over current system:
 *   1. Separates calibrated win probability from raw confidence
 *   2. Applies ALL Indian F&O transaction costs (7 components)
 *   3. Models slippage based on spread and market impact
 *   4. Provides EV sensitivity to cost/slippage changes (robustness test)
 *   5. Computes EV per unit risk, EV per capital, EV per expected hold time
 *   6. Applies probability calibration shrinkage per strategy
 *
 * Probability calibration:
 *   Raw model confidence ≠ true win probability.
 *   We apply logistic shrinkage toward 50% as a conservative prior.
 *   Once per-strategy calibration data is available, it overrides the prior.
 *
 * This module is I/O-free.
 */

// ─── Transaction Cost Model ───────────────────────────────────────────────────

/** Full Indian F&O transaction cost breakdown */
export interface IndiaFnOCostModel {
  /** Brokerage per round-trip in INR (flat model) */
  brokerage: number;
  /** STT as fraction of entry notional (buy side) */
  sttRate: number;
  /** NSE exchange fee as fraction of notional (both sides) */
  exchangeChargeRate: number;
  /** GST rate on brokerage + exchange charges */
  gstRate: number;
  /** SEBI turnover fee as fraction of notional */
  sebiRate: number;
  /** Stamp duty as fraction of entry notional (buy side only) */
  stampDutyRate: number;
  /** Half-spread estimate (one side) as fraction of price */
  halfSpread: number;
  /** Market impact per side as fraction of price (0 for small retail) */
  marketImpact: number;
  /** Latency cost factor (0 = instant execution, 1 = 5s delay) */
  latencyFactor: number;
}

export const DEFAULT_NSE_FNO_COST_MODEL: IndiaFnOCostModel = {
  brokerage: 40,          // ₹20 entry + ₹20 exit (Zerodha flat)
  sttRate: 0.000125,      // 0.0125% on options premium buy
  exchangeChargeRate: 0.00053, // NSE options
  gstRate: 0.18,          // GST on brokerage + exchange
  sebiRate: 0.000001,     // 0.0001%
  stampDutyRate: 0.00003, // 0.003% buy side
  halfSpread: 0.0003,     // 3bps per side (liquid F&O)
  marketImpact: 0,        // 0 for small retail orders
  latencyFactor: 0,       // 0 = instant (paper trading)
};

export const NSE_FUTURES_COST_MODEL: IndiaFnOCostModel = {
  brokerage: 40,
  sttRate: 0.000025,      // 0.0025% futures sell
  exchangeChargeRate: 0.00002, // NSE futures
  gstRate: 0.18,
  sebiRate: 0.000001,
  stampDutyRate: 0.00003,
  halfSpread: 0.0002,     // tighter spread for futures
  marketImpact: 0,
  latencyFactor: 0,
};

// ─── Strategy Calibration Profiles ───────────────────────────────────────────

/**
 * Per-strategy calibration parameters.
 * shrinkage: logistic shrinkage toward 0.5 (1.0 = no shrinkage, 0.0 = always 0.5)
 * maxWinPct: maximum capture fraction of stated target (conservative = 0.80)
 * targetCaptureRate: fraction of TP2 typically captured (based on paper data)
 *
 * These are PRIORS pending actual calibration data.
 * When OOS calibration data is available, it replaces these values.
 */
interface CalibrationProfile {
  shrinkage: number;
  maxWinPct: number;
  targetCaptureRate: number;
  baseWinRate: number;    // conservative prior win rate for this setup type
}

const STRATEGY_CALIBRATION: Record<string, CalibrationProfile> = {
  RANGE_EXPANSION: { shrinkage: 0.65, maxWinPct: 0.85, targetCaptureRate: 0.80, baseWinRate: 0.52 },
  MOMENTUM: { shrinkage: 0.60, maxWinPct: 0.80, targetCaptureRate: 0.75, baseWinRate: 0.50 },
  VOLUME_BREAKOUT: { shrinkage: 0.65, maxWinPct: 0.85, targetCaptureRate: 0.78, baseWinRate: 0.51 },
  OPENING_BREAKOUT: { shrinkage: 0.70, maxWinPct: 0.88, targetCaptureRate: 0.82, baseWinRate: 0.54 },
  OI_BUILDUP: { shrinkage: 0.60, maxWinPct: 0.80, targetCaptureRate: 0.75, baseWinRate: 0.50 },
  PCR_EXTREME: { shrinkage: 0.55, maxWinPct: 0.80, targetCaptureRate: 0.70, baseWinRate: 0.48 },
  IV_SPIKE: { shrinkage: 0.55, maxWinPct: 0.75, targetCaptureRate: 0.70, baseWinRate: 0.48 },
  LIQUIDITY_EDGE: { shrinkage: 0.60, maxWinPct: 0.82, targetCaptureRate: 0.78, baseWinRate: 0.51 },
  MAX_PAIN_GRAVITY: { shrinkage: 0.55, maxWinPct: 0.78, targetCaptureRate: 0.72, baseWinRate: 0.49 },
  INDIA_AI_SIGNALS: { shrinkage: 0.62, maxWinPct: 0.83, targetCaptureRate: 0.78, baseWinRate: 0.52 },
  DEFAULT: { shrinkage: 0.60, maxWinPct: 0.80, targetCaptureRate: 0.75, baseWinRate: 0.50 },
};

// ─── EV Result ────────────────────────────────────────────────────────────────

export interface EVResult {
  /** Calibrated win probability [0, 1] */
  pWin: number;
  /** Loss probability [0, 1] */
  pLoss: number;
  /** Expected reward if win (% of entry) */
  expectedWinPct: number;
  /** Expected loss if stopped out (% of entry) */
  expectedLossPct: number;
  /** Expected shortfall (CVaR proxy — expected loss in worst 20% of outcomes) */
  expectedShortfall: number;

  // ── Transaction costs ────────────────────────────────────────────────────
  brokerageCostPct: number;
  sttCostPct: number;
  exchangeCostPct: number;
  taxCostPct: number;
  sebiCostPct: number;
  stampDutyCostPct: number;
  /** Total regulatory + brokerage costs (as % of entry) */
  totalRegulatoryCostPct: number;

  // ── Market costs ─────────────────────────────────────────────────────────
  spreadCostPct: number;        // round-trip spread
  slippageCostPct: number;      // market impact + latency
  /** Total market-execution costs */
  totalMarketCostPct: number;

  /** Grand total cost (regulatory + market) */
  totalCostPct: number;

  // ── Core EV metrics ──────────────────────────────────────────────────────
  /** Gross EV before costs */
  grossEV: number;
  /** Net EV after all costs */
  netEV: number;
  /** EV per unit risk (netEV / expectedLossPct) — risk-adjusted trade quality */
  evPerUnitRisk: number;
  /** Kelly fraction estimate (fraction of capital to bet to maximize log-wealth) */
  kellyFraction: number;

  // ── Sensitivity ──────────────────────────────────────────────────────────
  /** Net EV at 1.5× costs */
  evAtCostMultiplier1_5: number;
  /** Net EV at 2× costs */
  evAtCostMultiplier2: number;
  /** Net EV at 3× costs */
  evAtCostMultiplier3: number;
  /** Whether strategy survives 2× cost stress */
  costRobust: boolean;

  // ── Holding time efficiency ───────────────────────────────────────────────
  /** Expected EV per hour of capital tied up */
  evPerHour: number | null;
  expectedHoldingHours: number | null;

  reasons: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Apply logistic calibration shrinkage.
 * Shrinks raw confidence toward the base rate to reduce overconfidence.
 */
function calibrateProbability(
  rawConfidence: number,
  strategyId: string,
  baseRate: number,
): number {
  const profile = STRATEGY_CALIBRATION[strategyId] ?? STRATEGY_CALIBRATION.DEFAULT;
  const shrinkage = profile.shrinkage;
  const calibrated = rawConfidence * shrinkage + baseRate * (1 - shrinkage);
  // Hard bounds: no strategy has < 30% or > 82% calibrated win probability
  return Math.max(0.30, Math.min(0.82, calibrated));
}

function computeTotalCostPct(
  model: IndiaFnOCostModel,
  notionalINR: number,
): number {
  if (notionalINR <= 0) return 0.5; // fallback 0.5% if notional unknown
  const brokPct = (model.brokerage / notionalINR) * 100;
  const sttPct = model.sttRate * 100;
  const exchangePct = model.exchangeChargeRate * 2 * 100; // round-trip
  const taxPct = model.gstRate * (model.brokerage / notionalINR + model.exchangeChargeRate * 2) * 100;
  const sebiPct = model.sebiRate * 2 * 100;
  const stampPct = model.stampDutyRate * 100;
  const spreadPct = model.halfSpread * 2 * 100; // round-trip
  const impactPct = model.marketImpact * 2 * 100;
  return brokPct + sttPct + exchangePct + taxPct + sebiPct + stampPct + spreadPct + impactPct;
}

// ─── Core EV Computation ─────────────────────────────────────────────────────

export interface EVInput {
  strategyId: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  rawConfidence: number;          // strategy's raw confidence [0, 1]
  notionalINR: number;            // position size in INR
  costModel?: IndiaFnOCostModel;
  /** Strategy-declared expected holding period in hours */
  expectedHoldingHours?: number;
  /** Spread from microstructure (if available) */
  observedSpreadPct?: number;
}

/**
 * Compute the complete expected value for an opportunity.
 *
 * Steps:
 *   1. Calibrate win probability from raw confidence
 *   2. Compute expected win/loss %
 *   3. Compute all 7 cost components
 *   4. Calculate net EV and sensitivity metrics
 */
export function computeFullEV(input: EVInput): EVResult {
  const reasons: string[] = [];
  const model = input.costModel ?? DEFAULT_NSE_FNO_COST_MODEL;
  const profile = STRATEGY_CALIBRATION[input.strategyId] ?? STRATEGY_CALIBRATION.DEFAULT;

  // ── Calibrate win probability ─────────────────────────────────────────
  const pWin = calibrateProbability(input.rawConfidence, input.strategyId, profile.baseWinRate);
  const pLoss = 1 - pWin;
  reasons.push(`P(win) calibrated: ${input.rawConfidence.toFixed(2)} → ${pWin.toFixed(2)}`);

  // ── Expected move ─────────────────────────────────────────────────────
  const riskPct = Math.abs(input.entry - input.stopLoss) / input.entry * 100;
  const rewardPct1 = Math.abs(input.target1 - input.entry) / input.entry * 100;
  const rewardPct2 = Math.abs(input.target2 - input.entry) / input.entry * 100;
  // Use 80/20 blend of TP1/TP2 as primary expected reward (conservative)
  const primaryRewardPct = rewardPct1 * 0.6 + rewardPct2 * 0.4;
  const expectedWinPct = primaryRewardPct * profile.targetCaptureRate * profile.maxWinPct;
  const expectedLossPct = riskPct; // stop is always honored fully

  reasons.push(`Risk: ${riskPct.toFixed(2)}%, E[reward]: ${expectedWinPct.toFixed(2)}%`);

  // ── Transaction costs ─────────────────────────────────────────────────
  const notional = input.notionalINR;
  const brokerageCostPct = notional > 0 ? (model.brokerage / notional) * 100 : 0.04;
  const sttCostPct = model.sttRate * 100;
  const exchangeCostPct = model.exchangeChargeRate * 2 * 100;
  const taxCostPct = model.gstRate * (model.brokerage / Math.max(notional, 1) + model.exchangeChargeRate * 2) * 100;
  const sebiCostPct = model.sebiRate * 2 * 100;
  const stampDutyCostPct = model.stampDutyRate * 100;
  const totalRegulatoryCostPct = brokerageCostPct + sttCostPct + exchangeCostPct + taxCostPct + sebiCostPct + stampDutyCostPct;

  // ── Market costs ──────────────────────────────────────────────────────
  const effectiveSpread = input.observedSpreadPct ?? model.halfSpread * 2 * 100;
  const spreadCostPct = effectiveSpread;
  const slippageCostPct = (model.marketImpact * 2 + model.halfSpread * model.latencyFactor) * 100;
  const totalMarketCostPct = spreadCostPct + slippageCostPct;

  const totalCostPct = totalRegulatoryCostPct + totalMarketCostPct;
  reasons.push(`Total costs: ${totalCostPct.toFixed(3)}%`);

  // ── Core EV ───────────────────────────────────────────────────────────
  const grossEV = pWin * expectedWinPct - pLoss * expectedLossPct;
  const netEV = grossEV - totalCostPct;

  reasons.push(`Gross EV: ${grossEV.toFixed(3)}%, Net EV: ${netEV.toFixed(3)}%`);

  // ── Risk metrics ──────────────────────────────────────────────────────
  const evPerUnitRisk = expectedLossPct > 0 ? netEV / expectedLossPct : 0;

  // Kelly fraction: (p×b - q) / b where b = win/loss ratio
  const b = expectedWinPct / Math.max(expectedLossPct, 0.01);
  const kellyFraction = Math.max(0, Math.min(0.25, (pWin * b - pLoss) / b));

  // Expected shortfall (CVaR-like): expected loss in worst 20% of outcomes
  // Approximation: if we lose, we expect to lose expectedLossPct × 1.2 on average
  const expectedShortfall = -(expectedLossPct * 1.2);

  // ── Cost sensitivity ──────────────────────────────────────────────────
  const evAtCostMultiplier1_5 = grossEV - totalCostPct * 1.5;
  const evAtCostMultiplier2 = grossEV - totalCostPct * 2;
  const evAtCostMultiplier3 = grossEV - totalCostPct * 3;
  const costRobust = evAtCostMultiplier2 > 0;

  if (!costRobust) reasons.push("COST_FRAGILE: unprofitable at 2× costs");

  // ── Holding time efficiency ────────────────────────────────────────────
  const holdingHours = input.expectedHoldingHours ?? null;
  const evPerHour = holdingHours && holdingHours > 0 ? netEV / holdingHours : null;

  return {
    pWin,
    pLoss,
    expectedWinPct,
    expectedLossPct,
    expectedShortfall,
    brokerageCostPct,
    sttCostPct,
    exchangeCostPct,
    taxCostPct,
    sebiCostPct,
    stampDutyCostPct,
    totalRegulatoryCostPct,
    spreadCostPct,
    slippageCostPct,
    totalMarketCostPct,
    totalCostPct,
    grossEV,
    netEV,
    evPerUnitRisk,
    kellyFraction,
    evAtCostMultiplier1_5,
    evAtCostMultiplier2,
    evAtCostMultiplier3,
    costRobust,
    evPerHour,
    expectedHoldingHours: holdingHours,
    reasons,
  };
}

// ─── Slippage Sensitivity ─────────────────────────────────────────────────────

/** Test strategy robustness under various latency/slippage scenarios */
export function testSlippageSensitivity(
  baseResult: EVResult,
  latencyScenarios: number[] = [0, 100, 250, 500, 1000, 2000, 5000],
): Array<{ latencyMs: number; additionalSlippagePct: number; adjustedNetEV: number; profitable: boolean }> {
  return latencyScenarios.map(latencyMs => {
    // Each 100ms adds ~0.01% additional slippage for liquid F&O (empirical estimate)
    const additionalSlippagePct = (latencyMs / 100) * 0.01;
    const adjustedNetEV = baseResult.netEV - additionalSlippagePct;
    return { latencyMs, additionalSlippagePct, adjustedNetEV, profitable: adjustedNetEV > 0 };
  });
}
