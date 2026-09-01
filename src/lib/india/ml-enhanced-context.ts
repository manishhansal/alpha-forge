/**
 * ML-Enhanced Market Context — augments the existing AI signals engine
 * with predictions from the Python multi-model decision engine.
 *
 * This module sits between the data layer and the signal builder. It:
 *   1. Calls the ML service for regime classification (replaces heuristic)
 *   2. Fetches ML stock rankings to prioritize the signal universe
 *   3. Gets strategy recommendations per stock
 *   4. Runs risk prediction on proposed trades
 *   5. Optimizes portfolio allocation across top picks
 *
 * The ML predictions are ADDITIVE — they enhance the existing confluence
 * scoring rather than replacing it entirely. When the ML service is down,
 * the system falls back seamlessly to the existing rule-based engine.
 */

import "server-only";

import type { AiMarketRegime } from "@/types/ai-signals";
import type { Quote } from "@/types/india";

import {
  isMLServiceHealthy,
  mlRegimeToAiRegime,
  mlRegimeToScore,
  predictRankings,
  predictRegime,
  predictRisk,
  predictStrategy,
  predictPortfolio,
  predictPriceRegime,
  type MLMarketRegime,
  type MLRankingResponse,
  type MLRegimeResponse,
  type MLRiskResponse,
  type MLStrategyResponse,
  type MLPortfolioResponse,
} from "./ml-client";
import {
  mlBreakerInstance,
  validateMLRegimeResponse,
  validateMLRankingResponse,
  validateMLRiskResponse,
  sanitizeFeatureVector,
  sanitizeBarMatrix,
} from "@/lib/chaos/ml-resilience";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceForecastResult {
  /** Predicted price regime for the next 1 hour. */
  regime: "bull" | "bear" | "flat";
  /** Probability of the predicted regime [0, 1]. */
  probability: number;
  /** 10th percentile expected move %. */
  q10: number;
  /** 90th percentile expected move %. */
  q90: number;
}

export interface MLEnhancedContext {
  /** Whether the ML service is available this cycle. */
  mlAvailable: boolean;
  /** ML-predicted regime (null when service is down). */
  regime: MLRegimeResponse | null;
  /** Mapped to the existing AiMarketRegime type. */
  aiRegime: AiMarketRegime;
  /** Directional score in [-1, 1] from the ML regime. */
  regimeScore: number;
  /** ML stock rankings (top N). */
  rankings: MLRankingResponse | null;
  /** Per-symbol strategy recommendation cache. */
  strategies: Map<string, MLStrategyResponse>;
  /** Per-symbol risk prediction cache. */
  risks: Map<string, MLRiskResponse>;
  /** Portfolio optimization result. */
  portfolio: MLPortfolioResponse | null;
  /**
   * TFT probabilistic 1-hour ahead price regime forecast.
   * Null when the ML service is offline or the forecast endpoint fails.
   * Requirement 8.5, 8.6
   */
  priceForecast: PriceForecastResult | null;
}

export interface MLContextInputs {
  /** NIFTY intraday % change. */
  niftyChangePct: number;
  /** BANKNIFTY intraday % change. */
  bankniftyChangePct: number;
  /** India VIX level. */
  indiaVix: number;
  /** NIFTY ATR(14) as % of price. */
  niftyAtrPct: number;
  /** NIFTY ADX(14). */
  niftyAdx: number;
  /** Advance/decline ratio [-1, 1]. */
  advanceDeclineRatio: number;
  /** % of F&O stocks above SMA20. */
  marketBreadth: number;
  /** Average sector % change. */
  sectorStrength: number;
  /** Market volume vs 20-day avg. */
  volumeRatio: number;
  /** Opening gap %. */
  gapPct: number;
  /** Additional optional features. */
  vixChangePct?: number;
  niftyRsi?: number;
  niftyMacdHist?: number;
  putCallRatio?: number;
  /** Per-stock feature vectors for ranking. */
  stockFeatures?: Array<{
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
  }>;
  /**
   * Last 60 5-minute OHLCV bars for the NIFTY/BANKNIFTY index used by the
   * TFT price forecaster. Each row: [open, high, low, close, volume, vpin,
   * atm_iv, pcr, oi_buildup]. Shape [n_bars, 9].
   * Pass an empty array to use the heuristic fallback (price regime not forecasted).
   */
  niftyLast60Bars?: number[][];
}

// ─── ML Context Builder ──────────────────────────────────────────────────────

/** In-memory cache for the ML context (60s TTL matching signal refresh). */
let _cachedContext: MLEnhancedContext | null = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Build the ML-enhanced context for the current trading session.
 *
 * Calls the ML service in parallel for regime + rankings, caches the result
 * for 60s (same cadence as the signal builder's refresh), and falls back to
 * the existing heuristic when the ML service is unreachable.
 *
 * Chaos Engineering Hardening:
 *   - Scenario 3:  MLCircuitBreaker prevents hammering a down ML service.
 *     After 4 consecutive failures the breaker opens for 30s before a probe.
 *   - Scenario 13: All ML responses are schema-validated before use;
 *     invalid output is discarded and the fallback heuristic runs.
 *   - Scenario 14: Feature vectors are sanitized for NaN/Infinity before
 *     every HTTP call.  Corrupted fields are logged as structured errors.
 */
export async function buildMLContext(
  inputs: MLContextInputs,
): Promise<MLEnhancedContext> {
  const now = Date.now();

  // Return cached context if still fresh
  if (_cachedContext && now - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedContext;
  }

  // ── Chaos Scenario 3: Circuit breaker check ─────────────────────────────
  if (!mlBreakerInstance.isCallable) {
    console.warn("[ml-context] circuit breaker OPEN — using heuristic fallback");
    const fallback = buildFallbackContext(inputs);
    _cachedContext = fallback;
    _cacheTimestamp = now;
    return fallback;
  }

  // Check ML service health first (fast, fail-fast)
  const mlHealthy = await isMLServiceHealthy();

  if (!mlHealthy) {
    mlBreakerInstance.recordFailure("health check failed");
    const fallback = buildFallbackContext(inputs);
    _cachedContext = fallback;
    _cacheTimestamp = now;
    return fallback;
  }

  // ── Chaos Scenario 14: Sanitize feature vectors before sending ──────────
  const regimeFeatures = {
    nifty_change_pct: inputs.niftyChangePct,
    banknifty_change_pct: inputs.bankniftyChangePct,
    india_vix: inputs.indiaVix,
    nifty_atr_pct: inputs.niftyAtrPct,
    nifty_adx: inputs.niftyAdx,
    advance_decline_ratio: inputs.advanceDeclineRatio,
    market_breadth: inputs.marketBreadth,
    sector_strength: inputs.sectorStrength,
    volume_ratio: inputs.volumeRatio,
    gap_pct: inputs.gapPct,
    vix_change_pct: inputs.vixChangePct,
    nifty_rsi: inputs.niftyRsi,
    nifty_macd_hist: inputs.niftyMacdHist,
    put_call_ratio: inputs.putCallRatio,
  };
  const { sanitized: cleanRegimeFeatures } = sanitizeFeatureVector(
    regimeFeatures as Record<string, number>,
    { label: "regime-features" },
  );

  // Call regime + rankings in parallel
  let rawRegimeResult: unknown = null;
  let rawRankingsResult: unknown = null;
  try {
    [rawRegimeResult, rawRankingsResult] = await Promise.all([
      predictRegime(cleanRegimeFeatures as Parameters<typeof predictRegime>[0]),
      inputs.stockFeatures && inputs.stockFeatures.length > 0
        ? predictRankings(
            inputs.stockFeatures.map((sf) => {
              const { sanitized } = sanitizeFeatureVector(
                sf as unknown as Record<string, number>,
                { label: `ranking-features:${sf.symbol}` },
              );
              return sanitized as typeof sf;
            }),
            "sideways",
            30,
          )
        : Promise.resolve(null),
    ]);
    mlBreakerInstance.recordSuccess();
  } catch (mlErr) {
    mlBreakerInstance.recordFailure((mlErr as Error).message);
    const fallback = buildFallbackContext(inputs);
    _cachedContext = fallback;
    _cacheTimestamp = now;
    return fallback;
  }

  // ── Chaos Scenario 13: Validate ML output before using ──────────────────
  const regimeValidation = validateMLRegimeResponse(rawRegimeResult);
  if (!regimeValidation.valid) {
    console.error(
      `[ml-context] invalid regime response — using fallback: ${regimeValidation.reason}`,
      { raw: rawRegimeResult },
    );
    mlBreakerInstance.recordFailure(`invalid regime: ${regimeValidation.reason}`);
    const fallback = buildFallbackContext(inputs);
    _cachedContext = fallback;
    _cacheTimestamp = now;
    return fallback;
  }
  const regimeResult = regimeValidation.data as MLRegimeResponse;

  let finalRankings: MLRankingResponse | null = null;
  if (rawRankingsResult !== null) {
    const rankValidation = validateMLRankingResponse(rawRankingsResult);
    if (rankValidation.valid) {
      finalRankings = rankValidation.data as MLRankingResponse;
    } else {
      console.warn(
        `[ml-context] invalid rankings response discarded: ${rankValidation.reason}`,
      );
    }
  }

  // If regime came back but rankings didn't, re-rank with the actual regime
  if (finalRankings === null && inputs.stockFeatures && inputs.stockFeatures.length > 0) {
    try {
      const rawReranked = await predictRankings(
        inputs.stockFeatures,
        regimeResult.regime,
        30,
      );
      const v = validateMLRankingResponse(rawReranked);
      if (v.valid) finalRankings = v.data as MLRankingResponse;
    } catch {
      // Best-effort
    }
  }

  const regime = regimeResult.regime;

  // Fetch the TFT 1-hour ahead price regime forecast (Requirement 8.5, 8.6).
  let priceForecast: PriceForecastResult | null = null;
  try {
    const rawBars = inputs.niftyLast60Bars ?? [];
    // ── Chaos Scenario 14: Sanitize bar matrix ───────────────────────────
    const { sanitized: cleanBars } = sanitizeBarMatrix(rawBars, { label: "nifty-bars" });
    const forecast = await predictPriceRegime(cleanBars);
    if (forecast) {
      priceForecast = {
        regime: forecast.regime,
        probability: forecast.probability,
        q10: forecast.q10,
        q90: forecast.q90,
      };
    }
  } catch {
    // Graceful degradation — priceForecast stays null
  }

  const context: MLEnhancedContext = {
    mlAvailable: true,
    regime: regimeResult,
    aiRegime: mlRegimeToAiRegime(regime),
    regimeScore: mlRegimeToScore(regime),
    rankings: finalRankings,
    strategies: new Map(),
    risks: new Map(),
    portfolio: null,
    priceForecast,
  };

  _cachedContext = context;
  _cacheTimestamp = now;
  return context;
}

/**
 * Get ML strategy recommendation for a specific stock.
 * Results are cached within the context for the current cycle.
 */
export async function getMLStrategy(
  context: MLEnhancedContext,
  symbol: string,
  features: {
    rsi: number;
    adx: number;
    atr_pct: number;
    volume_ratio: number;
    vwap_distance_pct: number;
    bollinger_position: number;
    trend_strength: number;
    volatility_rank: number;
    time_of_day_minutes: number;
  },
): Promise<MLStrategyResponse | null> {
  if (!context.mlAvailable || !context.regime) return null;

  // Check cache
  const cached = context.strategies.get(symbol);
  if (cached) return cached;

  const result = await predictStrategy({
    ...features,
    regime: context.regime.regime,
    symbol,
  });

  if (result) {
    context.strategies.set(symbol, result);
  }
  return result;
}

/**
 * Get ML risk prediction for a proposed trade.
 * Results are cached within the context for the current cycle.
 */
export async function getMLRisk(
  context: MLEnhancedContext,
  params: {
    symbol: string;
    direction: "LONG" | "SHORT";
    entry: number;
    stop_loss: number;
    target: number;
    atr: number;
    rsi: number;
    adx: number;
    volume_ratio: number;
    vix: number;
    pcr?: number;
    oi_buildup_score?: number;
  },
): Promise<MLRiskResponse | null> {
  if (!context.mlAvailable || !context.regime) return null;

  const cacheKey = `${params.symbol}-${params.direction}-${params.entry}`;
  const cached = context.risks.get(cacheKey);
  if (cached) return cached;

  const result = await predictRisk({
    ...params,
    regime: context.regime.regime,
  });

  if (result) {
    // ── Chaos Scenario 13: validate ML risk output before caching ─────────
    const validation = validateMLRiskResponse(result);
    if (!validation.valid) {
      console.warn(`[ml-context] invalid risk response for ${params.symbol}: ${validation.reason}`);
      return null;
    }
    context.risks.set(cacheKey, validation.data!);
    return validation.data;
  }
  return result;
}

/**
 * Run portfolio optimization on the top-ranked stocks.
 */
export async function getMLPortfolio(
  context: MLEnhancedContext,
  assets: Array<{
    symbol: string;
    expected_return: number;
    risk_score: number;
    sector: string;
    rank_score: number;
  }>,
): Promise<MLPortfolioResponse | null> {
  if (!context.mlAvailable) return null;

  const result = await predictPortfolio({
    assets,
    max_positions: 10,
    max_sector_weight: 0.4,
    risk_budget_pct: 2.0,
  });

  if (result) {
    context.portfolio = result;
  }
  return result;
}

/**
 * Invalidate the cached ML context (e.g. when regime changes rapidly).
 */
export function invalidateMLCache(): void {
  _cachedContext = null;
  _cacheTimestamp = 0;
}

// ─── Fallback ────────────────────────────────────────────────────────────────

function buildFallbackContext(inputs: MLContextInputs): MLEnhancedContext {
  // Map to a simple regime from raw inputs (mirrors the existing heuristic)
  let regime: MLMarketRegime = "sideways";
  if (inputs.niftyChangePct > 1 && inputs.indiaVix < 15) {
    regime = "strong_bull";
  } else if (inputs.niftyChangePct > 0.3 && inputs.advanceDeclineRatio > 0.1) {
    regime = "bull";
  } else if (inputs.niftyChangePct < -3 && inputs.indiaVix > 28) {
    regime = "crash";
  } else if (inputs.niftyChangePct < -1 && inputs.advanceDeclineRatio < -0.2) {
    regime = "bear";
  } else if (inputs.indiaVix > 22) {
    regime = "volatile";
  }

  return {
    mlAvailable: false,
    regime: null,
    aiRegime: mlRegimeToAiRegime(regime),
    regimeScore: mlRegimeToScore(regime),
    rankings: null,
    strategies: new Map(),
    risks: new Map(),
    portfolio: null,
    priceForecast: null,
  };
}
