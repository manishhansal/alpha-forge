/**
 * Market Data Quality and Reconciliation Engine
 *
 * Cross-validates data from multiple providers (ANGEL_ONE, UPSTOX, NSE, YAHOO)
 * and enforces data quality gates before data reaches:
 *   - AI / ML feature computation
 *   - Stock ranking
 *   - Strategy engines
 *   - Paper trading
 *   - Live execution
 *
 * Pipeline:
 *   raw tick / candle / quote
 *     → stale detection
 *     → OHLC structural validation
 *     → cross-provider price comparison
 *     → outlier / anomaly scoring
 *     → quality score + validation status assignment
 *     → safety gate (AI / paper-trading)
 *
 * All emitted events include source, qualityScore, and validationStatus so
 * downstream consumers can decide whether to use the data.
 */

import type { OHLCVCandle, ProviderId } from "../types";
import { mdLog, recordStaleData } from "../health";

// ─────────────────────────────────────────────────────────────────────────────
// Public constants — configurable thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Stale-data thresholds in milliseconds. Override via ReconciliationConfig. */
export const DEFAULT_STALE_THRESHOLDS_MS = {
  /** Live tick / quote stream. */
  LIVE_TICK_MAX_AGE_MS: 5_000,
  /** REST quote snapshot. */
  QUOTE_MAX_AGE_MS: 10_000,
  /** Option chain snapshot. */
  OPTION_CHAIN_MAX_AGE_MS: 30_000,
} as const;

/**
 * Per-instrument-type price-divergence thresholds (%).
 * If two providers differ by more than this, the data is flagged SUSPICIOUS.
 */
export const DEFAULT_DIVERGENCE_THRESHOLDS_PCT: Record<InstrumentCategory, number> = {
  INDEX: 0.10,   // NIFTY/SENSEX: tight — 0.10 %
  STOCK: 0.50,   // Equities: 0.50 %
  FUTURE: 0.30,  // Futures: 0.30 %
  OPTION: 2.00,  // Options: 2 % (wider bid-ask spreads)
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Broad instrument category used to select divergence thresholds. */
export type InstrumentCategory = "INDEX" | "STOCK" | "FUTURE" | "OPTION";

/** Possible quality states for a normalised market event. */
export type ValidationStatus =
  | "VALID"       // All checks passed.
  | "STALE"       // Timestamp too old.
  | "SUSPICIOUS"  // Anomaly detected but not definitely bad.
  | "INVALID"     // Structurally corrupt — must be rejected.
  | "UNVERIFIED"; // Only one provider — could not cross-validate.

/**
 * Quality envelope attached to every normalised market event.
 * Downstream consumers MUST check validationStatus before using the payload.
 */
export type QualityEnvelope = {
  source: ProviderId;
  /** 0.0 – 1.0 composite quality score. */
  qualityScore: number;
  validationStatus: ValidationStatus;
};

/** A normalised market event with quality metadata attached. */
export type QualifiedMarketEvent<T> = {
  data: T;
  quality: QualityEnvelope;
};

// ── Tick shape used by the reconciliation engine ──────────────────────────────

/** Minimal tick shape the engine needs — matches LiveTick from types.ts. */
export type ReconciliationTick = {
  token: string;
  symbol: string;
  ltp: number;
  /** UTC epoch-ms from the exchange. */
  exchangeTimestampMs: number;
  /** UTC epoch-ms when we received the tick. */
  receivedAtMs: number;
  provider: ProviderId;
  /** Instrument category used to select divergence threshold. */
  instrumentCategory?: InstrumentCategory;
};

// ── OHLC validation result ────────────────────────────────────────────────────

export type OHLCValidationError =
  | "HIGH_BELOW_LOW"
  | "OPEN_OUTSIDE_HIGH_LOW"
  | "CLOSE_OUTSIDE_HIGH_LOW"
  | "NEGATIVE_VOLUME"
  | "INVALID_TIMESTAMP"
  | "DUPLICATE_TIMESTAMP"
  | "NON_FINITE_OHLC"
  | "NEGATIVE_PRICE";

export type OHLCValidationResult =
  | { valid: true }
  | { valid: false; errors: OHLCValidationError[]; detail?: string };

// ── Cross-provider comparison ─────────────────────────────────────────────────

export type PriceComparisonResult = {
  symbol: string;
  providerA: ProviderId;
  providerB: ProviderId;
  priceA: number;
  priceB: number;
  absoluteDiff: number;
  percentageDiff: number;
  /** True when the divergence exceeds the configured threshold. */
  anomaly: boolean;
  threshold: number;
};

// ── Outlier / anomaly detection ───────────────────────────────────────────────

export type OutlierResult = {
  /** 0 = perfectly normal, 1 = extreme outlier. */
  anomalyScore: number;
  /** True when anomalyScore >= OUTLIER_ANOMALY_THRESHOLD. */
  isOutlier: boolean;
  /** Reason driving the score. */
  reason: "ATR_BREACH" | "PCT_MOVE_BREACH" | "VOLATILITY_BREACH" | "NORMAL";
};

// ── Provider health snapshot ──────────────────────────────────────────────────

export type ProviderHealthSnapshot = {
  provider: ProviderId;
  /** 0–100 composite score. */
  score: number;
  latencyMs: number | null;
  /** Recent error rate (0–1). */
  errorRate: number;
  /** Recent stale-data rate (0–1). */
  staleRate: number;
  /** Recent WebSocket disconnect rate (0–1). */
  wsDisconnectRate: number;
  /** Rate at which the provider recovers after disconnects (0–1). */
  recoveryRate: number;
};

// ── Safety gate decisions ─────────────────────────────────────────────────────

export type SafetyGateResult = {
  allowAI: boolean;
  allowPaperTrade: boolean;
  reason: string;
};

// ── Reconciliation configuration ─────────────────────────────────────────────

export type ReconciliationConfig = {
  staleThresholdsMs?: Partial<typeof DEFAULT_STALE_THRESHOLDS_MS>;
  divergenceThresholdsPct?: Partial<Record<InstrumentCategory, number>>;
  /**
   * When true, SUSPICIOUS data is forwarded to ML feature computation.
   * Off by default — must be an explicit opt-in.
   */
  allowSuspiciousForAI?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

/** Anomaly score >= this value → isOutlier = true. */
const OUTLIER_ANOMALY_THRESHOLD = 0.7;

/** Percentage move threshold above which an outlier check fires (10 %). */
const DEFAULT_PCT_MOVE_THRESHOLD = 10;

/**
 * ATR multiplier: move > N × ATR is flagged.
 * 3× ATR is a well-established threshold in market microstructure for
 * separating genuine price shocks from normal intraday volatility.
 */
const ATR_MULTIPLIER = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level provider health state
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderStats {
  /** Rolling window of latency samples (ms). */
  latencySamples: number[];
  /** Rolling window of boolean outcomes (true = error). */
  errorWindow: boolean[];
  /** Rolling window of stale-data booleans. */
  staleWindow: boolean[];
  /** Rolling window of WS disconnect booleans. */
  wsDisconnectWindow: boolean[];
  /** Rolling window of recovery booleans (true = recovered after disconnect). */
  recoveryWindow: boolean[];
}

const ROLLING_WINDOW = 100;

const providerStats = new Map<ProviderId, ProviderStats>();

function getStats(id: ProviderId): ProviderStats {
  let s = providerStats.get(id);
  if (!s) {
    s = {
      latencySamples: [],
      errorWindow: [],
      staleWindow: [],
      wsDisconnectWindow: [],
      recoveryWindow: [],
    };
    providerStats.set(id, s);
  }
  return s;
}

function push<T>(arr: T[], value: T): void {
  arr.push(value);
  if (arr.length > ROLLING_WINDOW) arr.shift();
}

function rate(window: boolean[]): number {
  if (window.length === 0) return 0;
  return window.filter(Boolean).length / window.length;
}

/** Reset all provider stats — used in tests. */
export function resetProviderStats(): void {
  providerStats.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Stale data detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a tick is stale based on both the exchange timestamp and
 * the receive timestamp.  Returns the age in ms and whether each threshold
 * was breached.
 */
export function checkTickStaleness(
  tick: ReconciliationTick,
  config?: ReconciliationConfig,
  now = Date.now(),
): { stale: boolean; exchangeAgeMs: number; receiveAgeMs: number } {
  const thresholds = {
    ...DEFAULT_STALE_THRESHOLDS_MS,
    ...config?.staleThresholdsMs,
  };

  const exchangeAgeMs = now - tick.exchangeTimestampMs;
  const receiveAgeMs = now - tick.receivedAtMs;

  const stale =
    exchangeAgeMs > thresholds.LIVE_TICK_MAX_AGE_MS ||
    receiveAgeMs > thresholds.LIVE_TICK_MAX_AGE_MS;

  if (stale) {
    recordStaleData(tick.provider, Math.max(exchangeAgeMs, receiveAgeMs), thresholds.LIVE_TICK_MAX_AGE_MS);
    mdLog("stale_data", {
      operationId: "checkTickStaleness",
      provider: tick.provider,
      symbol: tick.symbol,
      exchangeAgeMs,
      receiveAgeMs,
      thresholdMs: thresholds.LIVE_TICK_MAX_AGE_MS,
    });

    const stats = getStats(tick.provider);
    push(stats.staleWindow, true);
  } else {
    const stats = getStats(tick.provider);
    push(stats.staleWindow, false);
  }

  return { stale, exchangeAgeMs, receiveAgeMs };
}

/**
 * Check staleness of a quote snapshot (REST-fetched, uses QUOTE_MAX_AGE_MS).
 */
export function checkQuoteStaleness(
  provider: ProviderId,
  fetchedAtMs: number,
  config?: ReconciliationConfig,
  now = Date.now(),
): boolean {
  const thresholds = {
    ...DEFAULT_STALE_THRESHOLDS_MS,
    ...config?.staleThresholdsMs,
  };
  const ageMs = now - fetchedAtMs;
  const stale = ageMs > thresholds.QUOTE_MAX_AGE_MS;
  if (stale) {
    recordStaleData(provider, ageMs, thresholds.QUOTE_MAX_AGE_MS);
  }
  return stale;
}

/**
 * Check staleness of an option-chain snapshot.
 */
export function checkOptionChainStaleness(
  provider: ProviderId,
  fetchedAtMs: number,
  config?: ReconciliationConfig,
  now = Date.now(),
): boolean {
  const thresholds = {
    ...DEFAULT_STALE_THRESHOLDS_MS,
    ...config?.staleThresholdsMs,
  };
  const ageMs = now - fetchedAtMs;
  const stale = ageMs > thresholds.OPTION_CHAIN_MAX_AGE_MS;
  if (stale) {
    recordStaleData(provider, ageMs, thresholds.OPTION_CHAIN_MAX_AGE_MS);
  }
  return stale;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cross-provider price validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare prices reported by two providers for the same instrument.
 * Uses per-instrument-category thresholds — not one threshold for all types.
 */
export function comparePrices(
  symbol: string,
  providerA: ProviderId,
  priceA: number,
  providerB: ProviderId,
  priceB: number,
  category: InstrumentCategory = "STOCK",
  config?: ReconciliationConfig,
): PriceComparisonResult {
  const thresholds: Record<InstrumentCategory, number> = {
    ...DEFAULT_DIVERGENCE_THRESHOLDS_PCT,
    ...config?.divergenceThresholdsPct,
  };

  const threshold = thresholds[category];
  const absoluteDiff = Math.abs(priceA - priceB);
  const base = Math.min(priceA, priceB);
  const percentageDiff = base > 0 ? (absoluteDiff / base) * 100 : Infinity;
  const anomaly = percentageDiff > threshold;

  if (anomaly) {
    mdLog("data_mismatch", {
      operationId: "comparePrices",
      symbol,
      providerA,
      providerB,
      priceA,
      priceB,
      absoluteDiff,
      percentageDiff,
      threshold,
      category,
    });
  }

  return {
    symbol,
    providerA,
    providerB,
    priceA,
    priceB,
    absoluteDiff,
    percentageDiff,
    anomaly,
    threshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OHLC validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a single OHLCV candle.
 * Returns all structural errors — not just the first — so the caller can
 * decide whether to reject or tag the candle.
 */
export function validateOHLC(
  candle: OHLCVCandle,
  seenTimestamps?: Set<number>,
): OHLCValidationResult {
  const errors: OHLCValidationError[] = [];
  const { time, open, high, low, close, volume } = candle;

  // Timestamp
  if (!Number.isFinite(time) || time <= 0 || !Number.isInteger(time)) {
    errors.push("INVALID_TIMESTAMP");
  } else if (seenTimestamps) {
    if (seenTimestamps.has(time)) {
      errors.push("DUPLICATE_TIMESTAMP");
    } else {
      seenTimestamps.add(time);
    }
  }

  // Finite OHLC
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    errors.push("NON_FINITE_OHLC");
  } else {
    // Positive prices
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      errors.push("NEGATIVE_PRICE");
    } else {
      // Structural integrity
      if (high < low) errors.push("HIGH_BELOW_LOW");
      if (open > high || open < low) errors.push("OPEN_OUTSIDE_HIGH_LOW");
      if (close > high || close < low) errors.push("CLOSE_OUTSIDE_HIGH_LOW");
    }
  }

  // Volume
  if (volume != null && (!Number.isFinite(volume) || volume < 0)) {
    errors.push("NEGATIVE_VOLUME");
  }

  if (errors.length === 0) return { valid: true };
  return {
    valid: false,
    errors,
    detail: `o=${open} h=${high} l=${low} c=${close} v=${volume} t=${time}`,
  };
}

/**
 * Validate a sequence of candles, detecting duplicate timestamps across the
 * entire series.  Returns all errors with per-candle indexing.
 */
export function validateOHLCSequence(
  candles: OHLCVCandle[],
): Array<{ index: number; errors: OHLCValidationError[] }> {
  const seen = new Set<number>();
  const report: Array<{ index: number; errors: OHLCValidationError[] }> = [];

  for (let i = 0; i < candles.length; i++) {
    const result = validateOHLC(candles[i]!, seen);
    if (!result.valid) {
      report.push({ index: i, errors: result.errors });
    }
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Outlier / anomaly detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Average True Range over the last N candles.
 * Returns null when there are too few candles.
 */
export function computeATR(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < 2) return null;
  const window = candles.slice(-period);
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    const cur = window[i]!;
    const prev = window[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sum += tr;
  }
  return sum / (window.length - 1);
}

/**
 * Estimate recent volatility as the standard deviation of percentage returns
 * over the last N candles.
 */
export function computeVolatility(candles: OHLCVCandle[], period = 20): number | null {
  if (candles.length < 2) return null;
  const window = candles.slice(-period);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!.close;
    const cur = window[i]!.close;
    if (prev > 0) returns.push((cur - prev) / prev);
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * Score a new price event against the recent price history for anomalies.
 *
 * Uses ATR, percentage move, and recent volatility together into a
 * composite anomaly score (0–1).  A score >= 0.7 is flagged as an outlier.
 *
 * IMPORTANT: A large move is NOT automatically an outlier.  High-volatility
 * regimes raise the bar for what counts as anomalous.  Genuine flash crashes
 * that exceed ALL thresholds simultaneously receive the highest scores.
 */
export function detectOutlier(
  newPrice: number,
  recentCandles: OHLCVCandle[],
  pctMoveThreshold = DEFAULT_PCT_MOVE_THRESHOLD,
): OutlierResult {
  if (recentCandles.length === 0) {
    return { anomalyScore: 0, isOutlier: false, reason: "NORMAL" };
  }

  const lastClose = recentCandles[recentCandles.length - 1]!.close;
  if (lastClose <= 0) {
    return { anomalyScore: 0, isOutlier: false, reason: "NORMAL" };
  }

  const pctMove = Math.abs((newPrice - lastClose) / lastClose) * 100;
  const atr = computeATR(recentCandles);
  const volatility = computeVolatility(recentCandles);

  let score = 0;
  let reason: OutlierResult["reason"] = "NORMAL";

  // Component 1: percentage move vs configurable threshold
  if (pctMove > pctMoveThreshold) {
    const pctComponent = Math.min(1, (pctMove - pctMoveThreshold) / pctMoveThreshold);
    score = Math.max(score, pctComponent * 0.8);
    reason = "PCT_MOVE_BREACH";
  }

  // Component 2: ATR-based check — move > N × ATR
  if (atr !== null && atr > 0) {
    const moveInPrice = Math.abs(newPrice - lastClose);
    const atrRatio = moveInPrice / atr;
    if (atrRatio > ATR_MULTIPLIER) {
      const atrComponent = Math.min(1, (atrRatio - ATR_MULTIPLIER) / ATR_MULTIPLIER);
      const weighted = atrComponent * 0.7;
      if (weighted > score) {
        score = weighted;
        reason = "ATR_BREACH";
      }
    }
  }

  // Component 3: volatility-adjusted normalisation
  // Only engage when the series has meaningful volatility (≥ 0.1% daily σ).
  // Micro-σ from trending/deterministic series must not trigger spurious flags.
  // If volatility is genuinely high, attenuate the existing score downward so
  // genuine high-volatility sessions don't flood the anomaly queue.
  const MIN_MEANINGFUL_VOLATILITY = 0.001; // 0.1 % per period
  if (volatility !== null && volatility >= MIN_MEANINGFUL_VOLATILITY) {
    // Express pctMove relative to 3-sigma in the recent history
    const sigmaPct = volatility * 100 * 3;
    if (pctMove > sigmaPct) {
      const volComponent = Math.min(1, (pctMove - sigmaPct) / sigmaPct);
      const weighted = volComponent * 0.8;
      if (weighted > score) {
        score = weighted;
        reason = "VOLATILITY_BREACH";
      }
    } else if (score > 0) {
      // Attenuate: genuine vol session, reduce score
      const attenuationFactor = Math.max(0.3, 1 - volatility * 10);
      score = score * attenuationFactor;
    }
  }

  const isOutlier = score >= OUTLIER_ANOMALY_THRESHOLD;

  if (isOutlier) {
    mdLog("provider_failure", {
      operationId: "detectOutlier",
      reason,
      newPrice,
      lastClose,
      pctMove,
      atr,
      anomalyScore: score,
    });
  }

  return { anomalyScore: score, isOutlier, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Source confidence — build a QualityEnvelope for a tick
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a QualityEnvelope for a validated tick.
 *
 * The qualityScore is a composite of:
 *   - Staleness penalty (0–0.4)
 *   - Outlier penalty (0–0.3)
 *   - Cross-provider agreement bonus (0–0.3)
 *
 * validationStatus precedence: INVALID > STALE > SUSPICIOUS > UNVERIFIED > VALID
 */
export function buildQualityEnvelope(opts: {
  source: ProviderId;
  stale: boolean;
  outlier: OutlierResult;
  crossProviderAnomaly: boolean | null; // null = only one provider
  structurallyValid: boolean;
}): QualityEnvelope {
  const { source, stale, outlier, crossProviderAnomaly, structurallyValid } = opts;

  if (!structurallyValid) {
    return { source, qualityScore: 0, validationStatus: "INVALID" };
  }

  // Start at 1.0 and subtract penalties
  let score = 1.0;

  if (stale) score -= 0.40;
  if (outlier.isOutlier) score -= 0.30 * outlier.anomalyScore;
  if (crossProviderAnomaly === true) score -= 0.20;
  if (crossProviderAnomaly === null) score -= 0.05; // minor uncertainty penalty

  score = Math.max(0, Math.min(1, score));
  score = Math.round(score * 100) / 100;

  let validationStatus: ValidationStatus;

  if (!structurallyValid) {
    validationStatus = "INVALID";
  } else if (stale) {
    validationStatus = "STALE";
  } else if (outlier.isOutlier || crossProviderAnomaly === true) {
    validationStatus = "SUSPICIOUS";
  } else if (crossProviderAnomaly === null) {
    validationStatus = "UNVERIFIED";
  } else {
    validationStatus = "VALID";
  }

  return { source, qualityScore: score, validationStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Provider health score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a provider latency observation (from a successful call).
 */
export function recordProviderLatency(provider: ProviderId, latencyMs: number): void {
  const stats = getStats(provider);
  push(stats.latencySamples, latencyMs);
  push(stats.errorWindow, false);
}

/**
 * Record a provider error.
 */
export function recordProviderError(provider: ProviderId): void {
  const stats = getStats(provider);
  push(stats.errorWindow, true);
  mdLog("provider_failure", { operationId: "recordProviderError", provider });
}

/**
 * Record a WebSocket disconnect event.
 */
export function recordWsDisconnect(provider: ProviderId): void {
  const stats = getStats(provider);
  push(stats.wsDisconnectWindow, true);
  mdLog("provider_failure", { operationId: "recordWsDisconnect", provider });
}

/**
 * Record a WebSocket recovery (reconnected successfully after a disconnect).
 */
export function recordWsRecovery(provider: ProviderId): void {
  const stats = getStats(provider);
  push(stats.wsDisconnectWindow, false);
  push(stats.recoveryWindow, true);
  mdLog("provider_recovery", { operationId: "recordWsRecovery", provider });
}

/**
 * Calculate a provider health score from 0 to 100.
 *
 * Weights:
 *   - Latency (P95): 20 pts  — penalised progressively above 100ms
 *   - Error rate:    30 pts  — 0% error = full 30 pts
 *   - Stale rate:    25 pts  — 0% stale = full 25 pts
 *   - WS disconnect: 15 pts  — 0% disconnect = full 15 pts
 *   - Recovery rate: 10 pts  — 100% recovery = full 10 pts
 */
export function computeProviderHealthScore(provider: ProviderId): ProviderHealthSnapshot {
  const stats = getStats(provider);

  // Latency: P95
  const sorted = [...stats.latencySamples].sort((a, b) => a - b);
  let latencyMs: number | null = null;
  let latencyScore = 20;
  if (sorted.length > 0) {
    const idx = Math.ceil(0.95 * sorted.length) - 1;
    latencyMs = sorted[Math.max(0, idx)] ?? null;
    if (latencyMs !== null) {
      // 0ms = 20pts, 100ms = 20pts, degrades linearly to 0 at 500ms
      latencyScore = Math.max(0, 20 - Math.max(0, latencyMs - 100) * (20 / 400));
    }
  }

  const errRate = rate(stats.errorWindow);
  const staleRt = rate(stats.staleWindow);
  const wsRate = rate(stats.wsDisconnectWindow);
  const recRate = stats.recoveryWindow.length > 0 ? rate(stats.recoveryWindow) : 1;

  const errorScore = 30 * (1 - errRate);
  const staleScore = 25 * (1 - staleRt);
  const wsScore = 15 * (1 - wsRate);
  const recoveryScore = 10 * recRate;

  const score = Math.round(latencyScore + errorScore + staleScore + wsScore + recoveryScore);

  return {
    provider,
    score: Math.max(0, Math.min(100, score)),
    latencyMs,
    errorRate: errRate,
    staleRate: staleRt,
    wsDisconnectRate: wsRate,
    recoveryRate: recRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 8. Safety gates — AI and paper trading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a market event with the given quality envelope is safe
 * to forward to AI/ML feature computation and/or paper trading.
 *
 * Rules:
 *   AI gate:
 *     - INVALID  → blocked always
 *     - STALE    → blocked always
 *     - SUSPICIOUS → blocked unless config.allowSuspiciousForAI = true
 *     - UNVERIFIED / VALID → allowed
 *
 *   Paper-trade gate:
 *     - INVALID  → blocked
 *     - STALE    → blocked
 *     - SUSPICIOUS / UNVERIFIED / VALID → allowed
 */
export function evaluateSafetyGate(
  quality: QualityEnvelope,
  config?: ReconciliationConfig,
): SafetyGateResult {
  const { validationStatus } = quality;

  const blockingStatuses: ValidationStatus[] = ["INVALID", "STALE"];

  const blockedForAI =
    blockingStatuses.includes(validationStatus) ||
    (validationStatus === "SUSPICIOUS" && !config?.allowSuspiciousForAI);

  const blockedForPaper = blockingStatuses.includes(validationStatus);

  const reasons: string[] = [];
  if (validationStatus === "INVALID") reasons.push("structurally invalid data");
  if (validationStatus === "STALE") reasons.push("stale timestamp");
  if (validationStatus === "SUSPICIOUS" && blockedForAI) reasons.push("suspicious/anomalous data not permitted for AI");

  return {
    allowAI: !blockedForAI,
    allowPaperTrade: !blockedForPaper,
    reason: reasons.length > 0 ? reasons.join("; ") : "data quality acceptable",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Observability helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Emit a structured log for a provider-mismatch event. */
export function logProviderMismatch(result: PriceComparisonResult): void {
  mdLog("data_mismatch", {
    operationId: "logProviderMismatch",
    symbol: result.symbol,
    providerA: result.providerA,
    providerB: result.providerB,
    priceA: result.priceA,
    priceB: result.priceB,
    absoluteDiff: result.absoluteDiff,
    percentageDiff: result.percentageDiff,
    threshold: result.threshold,
  });
}

/** Emit a structured log for a rejected candle. */
export function logRejectedCandle(
  provider: ProviderId,
  candle: OHLCVCandle,
  errors: OHLCValidationError[],
): void {
  mdLog("data_mismatch", {
    operationId: "logRejectedCandle",
    provider,
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    errors,
  });
}

/** Emit a structured log for an outlier detection. */
export function logOutlier(
  provider: ProviderId,
  symbol: string,
  result: OutlierResult,
  price: number,
): void {
  mdLog("data_mismatch", {
    operationId: "logOutlier",
    provider,
    symbol,
    price,
    anomalyScore: result.anomalyScore,
    reason: result.reason,
  });
}

/** Emit a structured log for provider latency. */
export function logProviderLatency(provider: ProviderId, latencyMs: number): void {
  mdLog("provider_selected", {
    operationId: "logProviderLatency",
    provider,
    latencyMs,
  });
}

/** Emit a structured log for a provider health snapshot. */
export function logProviderHealth(snapshot: ProviderHealthSnapshot): void {
  mdLog("provider_selected", {
    operationId: "logProviderHealth",
    ...snapshot,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: full reconciliation pipeline for a single tick
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full reconciliation pipeline for one tick, optionally cross-checking
 * against a second provider's price.
 *
 * Returns a QualifiedMarketEvent with the original tick + quality envelope.
 */
export function reconcileTick(opts: {
  tick: ReconciliationTick;
  /** Recent candles for the same symbol, used for outlier detection. */
  recentCandles?: OHLCVCandle[];
  /** Price from a second provider for cross-validation. */
  secondProviderPrice?: { provider: ProviderId; price: number };
  config?: ReconciliationConfig;
  now?: number;
}): QualifiedMarketEvent<ReconciliationTick> {
  const { tick, recentCandles = [], secondProviderPrice, config, now = Date.now() } = opts;

  // 1. Stale check
  const { stale } = checkTickStaleness(tick, config, now);

  // 2. Outlier detection
  const outlier = detectOutlier(tick.ltp, recentCandles);

  // 3. Cross-provider comparison
  let crossProviderAnomaly: boolean | null = null;
  if (secondProviderPrice) {
    const comparison = comparePrices(
      tick.symbol,
      tick.provider,
      tick.ltp,
      secondProviderPrice.provider,
      secondProviderPrice.price,
      tick.instrumentCategory ?? "STOCK",
      config,
    );
    crossProviderAnomaly = comparison.anomaly;
  }

  // 4. Build quality envelope (tick itself is structurally valid at this point)
  const quality = buildQualityEnvelope({
    source: tick.provider,
    stale,
    outlier,
    crossProviderAnomaly,
    structurallyValid: true,
  });

  return { data: tick, quality };
}

/**
 * Run the full reconciliation pipeline for a single OHLCV candle.
 * Returns a QualifiedMarketEvent with the original candle + quality envelope.
 */
export function reconcileCandle(opts: {
  candle: OHLCVCandle;
  provider: ProviderId;
  seenTimestamps?: Set<number>;
  recentCandles?: OHLCVCandle[];
  config?: ReconciliationConfig;
}): QualifiedMarketEvent<OHLCVCandle> {
  const { candle, provider, seenTimestamps, recentCandles = [], config } = opts;

  // 3. OHLC structural validation
  const validation = validateOHLC(candle, seenTimestamps);
  if (!validation.valid) {
    logRejectedCandle(provider, candle, validation.errors);
    return {
      data: candle,
      quality: { source: provider, qualityScore: 0, validationStatus: "INVALID" },
    };
  }

  // 4. Outlier on close price
  const outlier = detectOutlier(candle.close, recentCandles);

  const quality = buildQualityEnvelope({
    source: provider,
    stale: false,
    outlier,
    crossProviderAnomaly: null,
    structurallyValid: true,
  });

  return { data: candle, quality };
}
