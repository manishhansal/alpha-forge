/**
 * ML Service Client — bridges the Next.js India trading engine to the
 * Python multi-model AI decision engine.
 *
 * Calls the FastAPI ML service at `ML_SERVICE_URL` (default localhost:8100)
 * for regime classification, stock ranking, strategy selection, risk
 * prediction, portfolio optimization, and SHAP explanations.
 *
 * All methods are fail-soft: if the ML service is down or responds with
 * an error, they return `null` so the existing heuristic engine continues
 * to drive signals (graceful degradation).
 */

import "server-only";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MLMarketRegime =
  | "strong_bull"
  | "bull"
  | "sideways"
  | "volatile"
  | "bear"
  | "crash";

export interface MLRegimeResponse {
  regime: MLMarketRegime;
  confidence: number;
  probabilities: Record<string, number>;
  features_used: number;
  model_version: string;
}

export interface MLStockRank {
  symbol: string;
  score: number;
  rank: number;
  factors: Record<string, number>;
}

export interface MLRankingResponse {
  rankings: MLStockRank[];
  model_version: string;
  regime_used: MLMarketRegime;
}

export type MLTradingStrategy =
  | "breakout"
  | "momentum"
  | "trend_following"
  | "mean_reversion"
  | "vwap_bounce"
  | "range_trading"
  | "scalping"
  | "volatility_breakout";

export interface MLStrategyResponse {
  strategy: MLTradingStrategy;
  confidence: number;
  alternatives: Array<Record<string, number>>;
  rationale: string;
}

export interface MLRiskResponse {
  prob_stop_hit: number;
  prob_target_hit: number;
  expected_drawdown_pct: number;
  suggested_position_size_pct: number;
  risk_score: number;
  factors: Record<string, number>;
}

export interface MLPortfolioAllocation {
  symbol: string;
  weight: number;
  sector: string;
  rationale: string;
}

export interface MLPortfolioResponse {
  allocations: MLPortfolioAllocation[];
  expected_return: number;
  portfolio_risk: number;
  sharpe_ratio: number;
  diversification_ratio: number;
}

export type MLExecutionAction =
  | "enter_now"
  | "wait"
  | "scale_in"
  | "partial_exit"
  | "full_exit"
  | "tighten_stop"
  | "trail_stop";

export interface MLExecutionDecision {
  action: MLExecutionAction;
  confidence: number;
  new_stop_loss?: number | null;
  exit_pct?: number | null;
  rationale: string;
}

export interface MLExplainContribution {
  feature: string;
  value: number;
  contribution: number;
  direction: "positive" | "negative";
}

export interface MLExplainResponse {
  model: string;
  prediction: string;
  base_value: number;
  contributions: MLExplainContribution[];
  total_positive: number;
  total_negative: number;
  top_drivers: string[];
}

export interface MLHealthStatus {
  status: string;
  timestamp: number;
  version: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL || "http://localhost:8100";

/** Timeout for ML service requests (ms). */
const ML_TIMEOUT_MS = 10_000;

/**
 * POST to the ML service with timeout and error handling.
 * Returns null on any failure (network, timeout, HTTP error).
 */
async function mlPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

    const res = await fetch(`${ML_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Next.js: don't cache ML predictions
      cache: "no-store",
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(
        `[ml-client] ${path} returned ${res.status}: ${res.statusText}`,
      );
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    // AbortError = timeout, TypeError = network failure
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ml-client] ${path} failed: ${msg}`);
    return null;
  }
}

async function mlGet<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${ML_SERVICE_URL}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if the ML service is reachable and healthy.
 */
export async function isMLServiceHealthy(): Promise<boolean> {
  const health = await mlGet<MLHealthStatus>("/health");
  return health?.status === "healthy";
}

/**
 * Classify the current market regime.
 */
export async function predictRegime(features: {
  nifty_change_pct: number;
  banknifty_change_pct: number;
  india_vix: number;
  nifty_atr_pct: number;
  nifty_adx: number;
  advance_decline_ratio: number;
  market_breadth: number;
  sector_strength: number;
  volume_ratio: number;
  gap_pct: number;
  vix_change_pct?: number;
  nifty_rsi?: number;
  nifty_macd_hist?: number;
  put_call_ratio?: number;
}): Promise<MLRegimeResponse | null> {
  return mlPost<MLRegimeResponse>("/predict/regime", features);
}

/**
 * Rank stocks by outperformance probability.
 */
export async function predictRankings(
  stocks: Array<{
    symbol: string;
    relative_volume: number;
    atr_expansion: number;
    momentum_5d: number;
    momentum_10d: number;
    vwap_distance_pct: number;
    ema_stack_score: number;
    rsi_14: number;
    macd_histogram: number;
    adx_14: number;
    sector_momentum: number;
    relative_strength_vs_nifty: number;
    market_breadth: number;
    gap_pct: number;
    [key: string]: unknown;
  }>,
  regime: MLMarketRegime,
  topN: number = 20,
): Promise<MLRankingResponse | null> {
  return mlPost<MLRankingResponse>("/predict/rankings", {
    stocks,
    regime,
    top_n: topN,
  });
}

/**
 * Select the optimal trading strategy for a stock.
 */
export async function predictStrategy(params: {
  regime: MLMarketRegime;
  symbol: string;
  rsi: number;
  adx: number;
  atr_pct: number;
  volume_ratio: number;
  vwap_distance_pct: number;
  bollinger_position: number;
  trend_strength: number;
  volatility_rank: number;
  time_of_day_minutes: number;
}): Promise<MLStrategyResponse | null> {
  return mlPost<MLStrategyResponse>("/predict/strategy", params);
}

/**
 * Estimate per-trade risk before entry.
 */
export async function predictRisk(params: {
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop_loss: number;
  target: number;
  atr: number;
  regime: MLMarketRegime;
  rsi: number;
  adx: number;
  volume_ratio: number;
  vix: number;
  pcr?: number;
  oi_buildup_score?: number;
}): Promise<MLRiskResponse | null> {
  return mlPost<MLRiskResponse>("/predict/risk", params);
}

/**
 * Optimize portfolio allocation.
 */
export async function predictPortfolio(params: {
  assets: Array<{
    symbol: string;
    expected_return: number;
    risk_score: number;
    sector: string;
    rank_score: number;
  }>;
  max_positions?: number;
  max_sector_weight?: number;
  risk_budget_pct?: number;
}): Promise<MLPortfolioResponse | null> {
  return mlPost<MLPortfolioResponse>("/predict/portfolio", params);
}

/**
 * Get RL execution decision for an active trade.
 */
export async function predictExecution(state: {
  symbol: string;
  direction: string;
  entry: number;
  current_price: number;
  stop_loss: number;
  target: number;
  unrealized_pnl_pct: number;
  time_in_trade_minutes: number;
  regime: MLMarketRegime;
  volume_ratio: number;
  price_vs_vwap: number;
  atr: number;
  momentum: number;
}): Promise<MLExecutionDecision | null> {
  return mlPost<MLExecutionDecision>("/predict/execution", state);
}

/**
 * Get SHAP explanation for a prediction.
 */
export async function explainPrediction(params: {
  model: "regime" | "ranker" | "strategy" | "risk";
  features: Record<string, number>;
  prediction: string;
}): Promise<MLExplainResponse | null> {
  return mlPost<MLExplainResponse>(
    `/explain/${params.model}`,
    params,
  );
}

// ─── Regime Mapping Helpers ──────────────────────────────────────────────────

/**
 * Map ML regime to the existing AiMarketRegime type used by the frontend.
 */
export function mlRegimeToAiRegime(
  regime: MLMarketRegime,
): "risk-on" | "risk-off" | "mixed" | "compressed" {
  switch (regime) {
    case "strong_bull":
    case "bull":
      return "risk-on";
    case "bear":
    case "crash":
      return "risk-off";
    case "volatile":
      return "mixed";
    case "sideways":
      return "compressed";
  }
}

/**
 * Map ML regime to a directional score in [-1, 1].
 */
export function mlRegimeToScore(regime: MLMarketRegime): number {
  const map: Record<MLMarketRegime, number> = {
    strong_bull: 1.0,
    bull: 0.5,
    sideways: 0.0,
    volatile: -0.2,
    bear: -0.6,
    crash: -1.0,
  };
  return map[regime] ?? 0;
}

/**
 * Map ML strategy to the existing India scalping strategy IDs.
 */
export function mlStrategyToIndiaStrategyId(
  strategy: MLTradingStrategy,
): string {
  const map: Record<MLTradingStrategy, string> = {
    breakout: "OPENING_BREAKOUT",
    momentum: "MOMENTUM",
    trend_following: "RANGE_EXPANSION",
    mean_reversion: "MAX_PAIN_GRAVITY",
    vwap_bounce: "LIQUIDITY_EDGE",
    range_trading: "PCR_EXTREME",
    scalping: "IV_SPIKE",
    volatility_breakout: "VOLUME_BREAKOUT",
  };
  return map[strategy] ?? "MOMENTUM";
}
