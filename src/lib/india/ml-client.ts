/**
 * ML Service Client v2 — bridges AlphaForge to ml-service2.0 (Phase 3/4).
 *
 * All requests hit the v2 API at `ML_SERVICE_URL` (default http://localhost:8100)
 * with mandatory X-API-KEY authentication.
 *
 * CHANGES FROM v1:
 *   - All endpoints now use /v2/predict/* paths (regime endpoint live, no more 503)
 *   - X-API-KEY header is added to every request (required by ml-service2.0 middleware)
 *   - New: predictMetaDecision() — calls /v2/meta/decide for the full MetaDecisionEngine
 *     output including GoNoGoDecision, SHAP rationale, and abstention signal
 *   - New: getModelRegistry() / getDriftAlerts() for observability
 *   - Existing callers of all other functions are unaffected (same signatures)
 *
 * ML_MODE controls fallback behaviour:
 *   required  — ML failure surfaces as an error (no silent fallback)
 *   fallback  — heuristic fallback allowed when ML service is down (default)
 *   disabled  — ML intentionally bypassed; all calls return null immediately
 */

import "server-only";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Controls ML fallback behaviour. Set via ML_MODE environment variable. */
export type MLMode = "required" | "fallback" | "disabled";

export function getMLMode(): MLMode {
  const raw = (process.env.ML_MODE ?? "fallback").toLowerCase();
  if (raw === "required" || raw === "fallback" || raw === "disabled") return raw;
  return "fallback";
}

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
  /** SHAP top-10 feature attributions (available when model is trained). */
  shap_top10?: Array<Record<string, number>>;
  provenance?: string;
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
  reason_codes?: string[];
  provenance?: string;
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
  provenance?: string;
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

// ─── MetaDecisionEngine types ─────────────────────────────────────────────────

/**
 * A single base-model output forwarded to the MetaDecisionEngine.
 * One entry per model (regime, ranker, strategy, risk, price, iv, rl, etc.)
 */
export interface MLModelOutput {
  /** Unique model identifier (e.g. "regimeClassifier", "riskPredictor"). */
  model_id: string;
  /** Model's recommended action: "BUY" | "SELL" | "WAIT" | "NO_TRADE" */
  action: "BUY" | "SELL" | "WAIT" | "NO_TRADE";
  /** Raw model confidence in [0, 1]. */
  confidence: number;
  /** Directional vote: 1 = bullish, -1 = bearish, 0 = neutral/wait. */
  direction: 1 | -1 | 0;
  /** Provenance from the model ("trained_model" | "heuristic" | "unavailable" etc.) */
  provenance: string;
}

/**
 * Optional news context forwarded from SentinelPulse to the MetaDecisionEngine.
 * When omitted, the LLM news reasoner is skipped (no degradation in ensemble logic).
 */
export interface MLNewsContext {
  news_impact_score?: number;
  impact_direction?: "BULLISH" | "BEARISH" | "NEUTRAL";
  impact_confidence?: number;
  sentiment?: {
    overall: number;
    market: number;
    company: number;
    macro: number;
    risk: number;
  };
  market_regime?: string;
  event_tags?: string[];
}

/**
 * Full MetaDecisionEngine output from POST /v2/meta/decide.
 *
 * This is the single authoritative Go/No-Go signal. It encodes:
 *   - action: BUY | SELL | WAIT | NO_TRADE
 *   - confidence + uncertainty (sum ≤ 1.0, both in [0,1])
 *   - agreement_ratio: fraction of models that voted for the plurality direction
 *   - abstention: true when the AbstentionPolicy suppressed a directional call
 *   - provenance: weakest-link provenance across all contributing models
 *   - reason_codes: structured audit codes (e.g. "HIGH_RISK", "NEWS_CONFLICT_OVERRIDE")
 *   - rationale: ≤ 200-char LLM/heuristic explanation — inject into OpportunityV1.evidence
 */
export interface MLMetaDecision {
  action: "BUY" | "SELL" | "WAIT" | "NO_TRADE";
  confidence: number;
  uncertainty: number;
  agreement: number;
  agreement_ratio: number;
  ensemble_score?: number;
  reason_codes: string[];
  contributing_models: string[];
  abstention: boolean;
  provenance: string;
  /** ≤ 200 char natural-language rationale — inject into OpportunityV1.evidence.decisionRationale */
  rationale?: string;
  symbol?: string;
  /** SHAP / explainability block. */
  explainability?: {
    top_features: Array<{ feature: string; contribution: number; direction: "positive" | "negative" }>;
    dominant_model: string;
    news_signal?: { direction: number; confidence: number; rationale: string };
  };
  /** Calibrated confidence decomposition. */
  decomposition?: {
    base_confidence: number;
    agreement_bonus: number;
    data_quality_penalty: number;
    regime_confidence: number;
    calibration_quality: number;
  };
}

// ─── HTTP layer ───────────────────────────────────────────────────────────────

const ML_SERVICE_URL =
  (process.env.ML_SERVICE_URL ?? "http://localhost:8100").replace(/\/$/, "");

/** API key sent in X-API-KEY header on every authenticated request. */
const ML_API_KEY =
  process.env.ML_SERVICE_API_KEY ?? process.env.ML_SERVICE_KEY ?? "";

/** Request timeout (ms). */
const ML_TIMEOUT_MS = 10_000;

/**
 * Authenticated POST to the ml-service2.0 v2 API.
 *
 * Automatically attaches X-API-KEY. Returns null on any failure when
 * ML_MODE=fallback. Throws when ML_MODE=required. Returns null immediately
 * when ML_MODE=disabled.
 */
async function mlPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  const mode = getMLMode();
  if (mode === "disabled") return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

    const res = await fetch(`${ML_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ml-service2.0 requires X-API-KEY on all /v2/* endpoints
        ...(ML_API_KEY ? { "X-API-KEY": ML_API_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const msg = `[ml-client] ${path} returned ${res.status}: ${res.statusText}`;
      if (mode === "required") throw new Error(msg);
      console.warn(msg);
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (mode === "required") {
      throw new Error(`[ml-client] ML_MODE=required but ${path} failed: ${msg}`);
    }
    console.warn(`[ml-client] ${path} failed: ${msg}`);
    return null;
  }
}

async function mlGet<T>(path: string): Promise<T | null> {
  const mode = getMLMode();
  if (mode === "disabled") return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${ML_SERVICE_URL}${path}`, {
      headers: {
        ...(ML_API_KEY ? { "X-API-KEY": ML_API_KEY } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timeout);
    if (!res.ok) {
      if (mode === "required") throw new Error(`[ml-client] ${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (mode === "required") {
      throw new Error(`[ml-client] ML_MODE=required but GET ${path} failed: ${msg}`);
    }
    return null;
  }
}

// ─── Generic helper (kept for backward compat with existing route handlers) ───

/**
 * Generic POST to the ML service — exposed for route handlers that prefer a
 * direct call. Returns null on any failure. Automatically adds auth header.
 */
export async function mlFetch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  return mlPost<T>(path, body);
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function isMLServiceHealthy(): Promise<boolean> {
  // /health is exempt from X-API-KEY auth — call without header
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${ML_SERVICE_URL}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data?.status === "healthy";
  } catch {
    return false;
  }
}

// ─── Core prediction endpoints (/v2/predict/*) ────────────────────────────────

/** Classify the current market regime. (v2 — fully live, no 503) */
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
  return mlPost<MLRegimeResponse>("/v2/predict/regime", features as Record<string, unknown>);
}

/** Rank stocks by outperformance probability. */
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
  return mlPost<MLRankingResponse>("/v2/predict/rankings", {
    stocks,
    regime,
    top_n: topN,
  });
}

/** Select the optimal trading strategy for a stock. */
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
  return mlPost<MLStrategyResponse>("/v2/predict/strategy", params as Record<string, unknown>);
}

/** Estimate per-trade risk before entry. */
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
  return mlPost<MLRiskResponse>("/v2/predict/risk", params as Record<string, unknown>);
}

/** Optimize portfolio allocation (legacy v1). */
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
  return mlPost<MLPortfolioResponse>("/v2/predict/portfolio", params as Record<string, unknown>);
}

/** Get RL execution decision for an active trade. */
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
  return mlPost<MLExecutionDecision>("/v2/predict/execution", state as Record<string, unknown>);
}

/** Get SHAP explanation for a prediction. */
export async function explainPrediction(params: {
  model: "regime" | "ranker" | "strategy" | "risk";
  features: Record<string, number>;
  prediction: string;
}): Promise<MLExplainResponse | null> {
  return mlPost<MLExplainResponse>(
    `/v2/explain/${params.model}`,
    params as Record<string, unknown>,
  );
}

// ─── MetaDecisionEngine — the crown jewel ─────────────────────────────────────

/**
 * Call the MetaDecisionEngine for a final Go/No-Go signal.
 *
 * This is the primary integration point for Phase 4. It takes outputs from
 * ALL base models and returns a single calibrated, explainable verdict.
 *
 * Usage in the Opportunity Pipeline (Stage 12):
 *
 *   const meta = await predictMetaDecision({
 *     symbol: "NIFTY",
 *     regime: "bull",
 *     model_outputs: [
 *       { model_id: "regimeClassifier", action: "BUY", confidence: 0.78,
 *         direction: 1, provenance: "trained_model" },
 *       { model_id: "riskPredictor", action: "WAIT", confidence: 0.55,
 *         direction: 0, provenance: "heuristic" },
 *       // ... up to 7 models
 *     ],
 *     news_context: sentinelPulsePayload,   // optional — from SentinelPulse
 *   });
 *
 *   if (meta?.abstention || meta?.action === "NO_TRADE") {
 *     // Hard gate: ML says abstain — reject the opportunity
 *   }
 *   // meta.rationale → inject into opportunity.evidence.decisionRationale
 *   // meta.confidence → use as mlScore in OpportunityScoreVector
 *
 * Key guarantee from ml-service2.0:
 *   meta.confidence + meta.uncertainty <= 1.0
 *   meta.agreement_ratio is the fraction of available (non-WAIT) models
 *   that voted for the plurality direction — a value < 0.5 triggers
 *   automatic abstention.
 *
 * @see src/lib/india/ml-service2-integration.ts for the full pipeline wiring
 */
export async function predictMetaDecision(params: {
  symbol: string;
  regime?: string;
  model_outputs: MLModelOutput[];
  news_context?: MLNewsContext;
  risk_context?: { prob_stop_hit?: number };
}): Promise<MLMetaDecision | null> {
  return mlPost<MLMetaDecision>("/v2/meta/decide", {
    symbol: params.symbol,
    regime: params.regime ?? "sideways",
    model_outputs: params.model_outputs,
    news_context: params.news_context ?? null,
    risk_context: params.risk_context ?? null,
  });
}

// ─── Analytics endpoints ───────────────────────────────────────────────────────

/** Enrich an option chain with Black-76/BS greeks from the ML service. */
export async function fetchOptionChainGreeks(params: {
  chain: unknown[];
  spot: number;
  india_vix: number;
  expiry_dt: string;
}): Promise<unknown[] | null> {
  const result = await mlPost<unknown[]>(
    "/v2/analytics/greeks",
    params as Record<string, unknown>,
  );
  if (!result) return null;
  if (Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if ("strikes" in r && Array.isArray(r.strikes)) return r.strikes as unknown[];
  return null;
}

/** Classify IV regime from option chain data. */
export async function predictIVRegime(params: {
  data: number[][];
}): Promise<{ iv_regime: string } | null> {
  return mlPost<{ iv_regime: string }>(
    "/v2/predict/iv-regime",
    params as Record<string, unknown>,
  );
}

/** Get the implied volatility surface for a symbol. */
export async function fetchVolSurface(
  symbol: string,
): Promise<Record<string, unknown> | null> {
  return mlGet<Record<string, unknown>>(
    `/v2/analytics/vol-surface?symbol=${encodeURIComponent(symbol)}`,
  );
}

/** Compute the IV surface from per-expiry snapshots. */
export async function computeVolSurface(params: {
  symbol: string;
  snapshots_by_expiry: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  return mlPost<Record<string, unknown>>(
    "/v2/analytics/vol-surface",
    params as Record<string, unknown>,
  );
}

/** Portfolio optimization via Riskfolio-Lib (v2 endpoint). */
export async function predictPortfolioV2(params: {
  symbols: string[];
  method?: string;
  returns?: Record<string, number[]>;
  alpha?: number;
}): Promise<Record<string, unknown> | null> {
  return mlPost<Record<string, unknown>>(
    "/v2/predict/portfolio-v2",
    params as Record<string, unknown>,
  );
}

/** Get the 1-hour ahead price regime forecast (TFT model). */
export async function predictPriceRegime(last60Bars: number[][]): Promise<{
  regime: "bull" | "bear" | "flat";
  probability: number;
  q10: number;
  q90: number;
} | null> {
  const result = await mlPost<{
    regime: string;
    probability: number;
    q10: number;
    q90: number;
  }>("/v2/predict/price-regime", { last_60_bars: last60Bars });

  if (!result) return null;
  if (result.regime !== "bull" && result.regime !== "bear" && result.regime !== "flat") return null;
  return {
    regime: result.regime as "bull" | "bear" | "flat",
    probability: result.probability,
    q10: result.q10,
    q90: result.q90,
  };
}

// ─── Observability endpoints ──────────────────────────────────────────────────

/** Get per-model load status from the ML service registry. */
export async function getMLModelsStatus(): Promise<Record<string, unknown> | null> {
  return mlGet<Record<string, unknown>>("/v2/models/status");
}

/** Get the full model registry (artifacts + lifecycle stages). */
export async function getModelRegistry(): Promise<unknown[] | null> {
  return mlGet<unknown[]>("/v2/models/registry");
}

/**
 * Fetch active drift alerts from the monitoring layer.
 * Useful for the AlphaForge ops dashboard.
 */
export async function getDriftAlerts(): Promise<unknown[] | null> {
  return mlGet<unknown[]>("/monitoring/alerts");
}

// ─── Regime Mapping Helpers ───────────────────────────────────────────────────

/** Map ML regime to the existing AiMarketRegime type used by the frontend. */
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

/** Map ML regime to a directional score in [-1, 1]. */
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

/** Map ML strategy to the existing India scalping strategy IDs. */
export function mlStrategyToIndiaStrategyId(
  strategy: MLTradingStrategy,
): string {
  const map: Record<MLTradingStrategy, string> = {
    breakout:            "OPENING_BREAKOUT",
    momentum:            "MOMENTUM",
    trend_following:     "RANGE_EXPANSION",
    mean_reversion:      "MAX_PAIN_GRAVITY",
    vwap_bounce:         "LIQUIDITY_EDGE",
    range_trading:       "PCR_EXTREME",
    scalping:            "IV_SPIKE",
    volatility_breakout: "VOLUME_BREAKOUT",
  };
  return map[strategy] ?? "MOMENTUM";
}

/**
 * Map MLMetaDecision to a calibrated mlScore for OpportunityScoreVector.
 *
 * Returns 0.5 (neutral) when the decision is null or abstained, so that the
 * pipeline scoring is not distorted by an unavailable ML service.
 */
export function metaDecisionToMlScore(meta: MLMetaDecision | null): number {
  if (!meta || meta.abstention) return 0.5;
  if (meta.action === "NO_TRADE") return 0.2;
  if (meta.action === "WAIT") return 0.45;
  // BUY or SELL — use calibrated confidence, adjusted by agreement
  return Math.min(1, meta.confidence * meta.agreement_ratio * 2);
}

/**
 * Extract the rationale string from a MetaDecision for injection into
 * OpportunityV1.evidence.decisionRationale.
 *
 * Falls back to a human-readable summary when the rationale field is absent.
 */
export function metaDecisionRationale(
  meta: MLMetaDecision | null,
  symbol: string,
): string {
  if (!meta) return `${symbol}: ML service unavailable — heuristic scoring applied.`;
  if (meta.rationale) return meta.rationale;

  const codes = meta.reason_codes.slice(0, 2).join(", ") || "model_consensus";
  return `${symbol}: ${meta.action} | conf=${meta.confidence.toFixed(2)} agree=${meta.agreement_ratio.toFixed(2)} | ${codes}`.slice(0, 200);
}
