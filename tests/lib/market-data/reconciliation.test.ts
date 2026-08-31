// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  // Stale detection
  checkTickStaleness,
  checkQuoteStaleness,
  checkOptionChainStaleness,
  DEFAULT_STALE_THRESHOLDS_MS,
  // Cross-provider price validation
  comparePrices,
  DEFAULT_DIVERGENCE_THRESHOLDS_PCT,
  // OHLC validation
  validateOHLC,
  validateOHLCSequence,
  // Outlier detection
  detectOutlier,
  computeATR,
  computeVolatility,
  // Quality envelope
  buildQualityEnvelope,
  // Provider health
  computeProviderHealthScore,
  recordProviderLatency,
  recordProviderError,
  recordWsDisconnect,
  recordWsRecovery,
  resetProviderStats,
  // Safety gates
  evaluateSafetyGate,
  // Pipeline helpers
  reconcileTick,
  reconcileCandle,
} from "@/lib/market-data/services/reconciliation.service";
import { resetAllHealth } from "@/lib/market-data/health";

import type {
  ReconciliationTick,
  QualityEnvelope,
  OutlierResult,
  ReconciliationConfig,
} from "@/lib/market-data/services/reconciliation.service";
import type { OHLCVCandle, ProviderId } from "@/lib/market-data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed epoch for deterministic tests

function tick(overrides: Partial<ReconciliationTick> = {}): ReconciliationTick {
  return {
    token: "2885",
    symbol: "RELIANCE",
    ltp: 2900.0,
    exchangeTimestampMs: NOW - 1_000,
    receivedAtMs: NOW - 500,
    provider: "angel_one",
    instrumentCategory: "STOCK",
    ...overrides,
  };
}

function candle(overrides: Partial<OHLCVCandle> = {}): OHLCVCandle {
  return {
    time: 1_700_000_000,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 10_000,
    ...overrides,
  };
}

/** Generate N simple ascending candles around a base price. */
function candleSeries(n: number, base = 100, startTime = 1_700_000_000): OHLCVCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: startTime + i * 60,
    open: base + i,
    high: base + i + 5,
    low: base + i - 5,
    close: base + i + 2,
    volume: 10_000,
  }));
}

beforeEach(() => {
  resetProviderStats();
  resetAllHealth();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. STALE DATA DETECTION
// ═════════════════════════════════════════════════════════════════════════════

describe("checkTickStaleness()", () => {
  it("accepts a fresh tick", () => {
    const t = tick({ exchangeTimestampMs: NOW - 1_000, receivedAtMs: NOW - 500 });
    const r = checkTickStaleness(t, undefined, NOW);
    expect(r.stale).toBe(false);
  });

  it("flags a stale exchange timestamp", () => {
    const t = tick({ exchangeTimestampMs: NOW - 10_000, receivedAtMs: NOW - 100 });
    const r = checkTickStaleness(t, undefined, NOW);
    expect(r.stale).toBe(true);
    expect(r.exchangeAgeMs).toBe(10_000);
  });

  it("flags a stale receive timestamp even when exchange ts is fresh", () => {
    const t = tick({ exchangeTimestampMs: NOW - 1_000, receivedAtMs: NOW - 20_000 });
    const r = checkTickStaleness(t, undefined, NOW);
    expect(r.stale).toBe(true);
  });

  it("respects a custom LIVE_TICK_MAX_AGE_MS threshold", () => {
    const config: ReconciliationConfig = {
      staleThresholdsMs: { LIVE_TICK_MAX_AGE_MS: 2_000 },
    };
    const fresh = tick({ exchangeTimestampMs: NOW - 1_500, receivedAtMs: NOW - 100 });
    expect(checkTickStaleness(fresh, config, NOW).stale).toBe(false);

    const stale = tick({ exchangeTimestampMs: NOW - 2_500, receivedAtMs: NOW - 100 });
    expect(checkTickStaleness(stale, config, NOW).stale).toBe(true);
  });

  it("tick just at the threshold boundary is not stale", () => {
    const limit = DEFAULT_STALE_THRESHOLDS_MS.LIVE_TICK_MAX_AGE_MS;
    const t = tick({ exchangeTimestampMs: NOW - limit, receivedAtMs: NOW - 100 });
    expect(checkTickStaleness(t, undefined, NOW).stale).toBe(false);
  });
});

describe("checkQuoteStaleness()", () => {
  it("accepts a fresh quote", () => {
    expect(checkQuoteStaleness("angel_one", NOW - 5_000, undefined, NOW)).toBe(false);
  });

  it("rejects a stale quote", () => {
    expect(checkQuoteStaleness("angel_one", NOW - 15_000, undefined, NOW)).toBe(true);
  });

  it("respects custom QUOTE_MAX_AGE_MS", () => {
    const config: ReconciliationConfig = { staleThresholdsMs: { QUOTE_MAX_AGE_MS: 3_000 } };
    expect(checkQuoteStaleness("upstox", NOW - 2_000, config, NOW)).toBe(false);
    expect(checkQuoteStaleness("upstox", NOW - 4_000, config, NOW)).toBe(true);
  });
});

describe("checkOptionChainStaleness()", () => {
  it("accepts a fresh option chain", () => {
    expect(checkOptionChainStaleness("nse", NOW - 20_000, undefined, NOW)).toBe(false);
  });

  it("rejects a stale option chain", () => {
    expect(checkOptionChainStaleness("nse", NOW - 35_000, undefined, NOW)).toBe(true);
  });

  it("respects custom OPTION_CHAIN_MAX_AGE_MS", () => {
    const config: ReconciliationConfig = { staleThresholdsMs: { OPTION_CHAIN_MAX_AGE_MS: 5_000 } };
    expect(checkOptionChainStaleness("nse", NOW - 6_000, config, NOW)).toBe(true);
    expect(checkOptionChainStaleness("nse", NOW - 4_000, config, NOW)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CROSS-PROVIDER PRICE VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

describe("comparePrices() — provider agreement", () => {
  it("accepts close prices from two providers (within threshold)", () => {
    // 245.50 vs 245.55 — delta 0.02%
    const r = comparePrices("RELIANCE", "angel_one", 245.50, "upstox", 245.55, "STOCK");
    expect(r.anomaly).toBe(false);
    expect(r.percentageDiff).toBeLessThan(DEFAULT_DIVERGENCE_THRESHOLDS_PCT.STOCK);
  });

  it("uses the correct absolute and percentage diff", () => {
    const r = comparePrices("NIFTY", "angel_one", 20_000, "nse", 20_040, "INDEX");
    expect(r.absoluteDiff).toBeCloseTo(40);
    expect(r.percentageDiff).toBeCloseTo(0.2);
  });
});

describe("comparePrices() — provider disagreement", () => {
  it("flags a large stock price discrepancy (245.50 vs 252.80)", () => {
    const r = comparePrices("RELIANCE", "angel_one", 245.50, "upstox", 252.80, "STOCK");
    expect(r.anomaly).toBe(true);
    expect(r.percentageDiff).toBeGreaterThan(DEFAULT_DIVERGENCE_THRESHOLDS_PCT.STOCK);
  });

  it("uses per-category thresholds — INDEX is stricter than STOCK", () => {
    // 0.12% diff — within STOCK threshold but outside INDEX threshold
    const stock = comparePrices("SYM", "angel_one", 1000, "upstox", 1001.2, "STOCK");
    const index = comparePrices("SYM", "angel_one", 1000, "upstox", 1001.2, "INDEX");
    expect(stock.anomaly).toBe(false);
    expect(index.anomaly).toBe(true);
  });

  it("uses OPTION threshold (2%) — wider than STOCK", () => {
    // 1% diff — would be anomalous for STOCK but not for OPTION
    const option = comparePrices("NIFTY24000CE", "angel_one", 100, "upstox", 101, "OPTION");
    expect(option.anomaly).toBe(false);
    const stock = comparePrices("RELIANCE", "angel_one", 100, "upstox", 101, "STOCK");
    expect(stock.anomaly).toBe(true);
  });

  it("uses FUTURE threshold (0.30%)", () => {
    // 0.25% — within FUTURE, outside STOCK
    const future = comparePrices("NIFTY-FUT", "angel_one", 20_000, "upstox", 20_050, "FUTURE");
    expect(future.anomaly).toBe(false); // 0.25% < 0.30%
    const future2 = comparePrices("NIFTY-FUT", "angel_one", 20_000, "upstox", 20_070, "FUTURE");
    expect(future2.anomaly).toBe(true); // 0.35% > 0.30%
  });

  it("respects a custom divergence threshold override", () => {
    const config: ReconciliationConfig = {
      divergenceThresholdsPct: { STOCK: 0.1 },
    };
    // 0.2% diff — within default 0.5% but outside custom 0.1%
    const r = comparePrices("XYZ", "angel_one", 1000, "upstox", 1002, "STOCK", config);
    expect(r.anomaly).toBe(true);
  });

  it("includes threshold in the result", () => {
    const r = comparePrices("SYM", "angel_one", 100, "nse", 101, "INDEX");
    expect(r.threshold).toBe(DEFAULT_DIVERGENCE_THRESHOLDS_PCT.INDEX);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. OHLC VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

describe("validateOHLC()", () => {
  it("accepts a valid candle", () => {
    expect(validateOHLC(candle())).toEqual({ valid: true });
  });

  describe("timestamp", () => {
    it("rejects zero timestamp", () => {
      const r = validateOHLC(candle({ time: 0 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("INVALID_TIMESTAMP");
    });

    it("rejects negative timestamp", () => {
      const r = validateOHLC(candle({ time: -1 }));
      expect(r.valid).toBe(false);
    });

    it("rejects non-integer timestamp", () => {
      const r = validateOHLC(candle({ time: 1_700_000_000.5 }));
      expect(r.valid).toBe(false);
    });

    it("rejects NaN timestamp", () => {
      const r = validateOHLC(candle({ time: NaN }));
      expect(r.valid).toBe(false);
    });

    it("detects duplicate timestamp via seenTimestamps set", () => {
      const seen = new Set<number>();
      validateOHLC(candle({ time: 1_700_000_000 }), seen);
      const r = validateOHLC(candle({ time: 1_700_000_000 }), seen);
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("DUPLICATE_TIMESTAMP");
    });

    it("does not flag the same timestamp without a seenTimestamps set", () => {
      // Without the set, duplicate detection is the caller's responsibility
      expect(validateOHLC(candle({ time: 1_700_000_000 })).valid).toBe(true);
    });
  });

  describe("high < low", () => {
    it("rejects high < low", () => {
      const r = validateOHLC(candle({ high: 90, low: 95 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("HIGH_BELOW_LOW");
    });
  });

  describe("open outside high/low", () => {
    it("rejects open > high", () => {
      const r = validateOHLC(candle({ open: 115, high: 110 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("OPEN_OUTSIDE_HIGH_LOW");
    });

    it("rejects open < low", () => {
      const r = validateOHLC(candle({ open: 90, low: 95 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("OPEN_OUTSIDE_HIGH_LOW");
    });
  });

  describe("close outside high/low", () => {
    it("rejects close > high", () => {
      const r = validateOHLC(candle({ close: 115, high: 110 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("CLOSE_OUTSIDE_HIGH_LOW");
    });

    it("rejects close < low", () => {
      const r = validateOHLC(candle({ close: 90, low: 95 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("CLOSE_OUTSIDE_HIGH_LOW");
    });
  });

  describe("volume", () => {
    it("rejects negative volume", () => {
      const r = validateOHLC(candle({ volume: -1 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("NEGATIVE_VOLUME");
    });

    it("accepts zero volume (possible during no-trade candle)", () => {
      expect(validateOHLC(candle({ volume: 0 })).valid).toBe(true);
    });
  });

  describe("negative / zero prices", () => {
    it("rejects zero open", () => {
      const r = validateOHLC(candle({ open: 0, low: 0 }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("NEGATIVE_PRICE");
    });

    it("rejects negative close", () => {
      const r = validateOHLC(candle({ close: -5 }));
      expect(r.valid).toBe(false);
    });
  });

  describe("non-finite OHLC", () => {
    it("rejects NaN high", () => {
      const r = validateOHLC(candle({ high: NaN }));
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.errors).toContain("NON_FINITE_OHLC");
    });

    it("rejects Infinity low", () => {
      const r = validateOHLC(candle({ low: Infinity }));
      expect(r.valid).toBe(false);
    });
  });

  it("collects multiple errors in one pass", () => {
    // high < low AND negative volume
    const r = validateOHLC(candle({ high: 90, low: 95, open: 92, close: 91, volume: -10 }));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors).toContain("HIGH_BELOW_LOW");
      expect(r.errors).toContain("NEGATIVE_VOLUME");
    }
  });
});

describe("validateOHLCSequence()", () => {
  it("returns empty array for a clean sequence", () => {
    const series = candleSeries(5);
    expect(validateOHLCSequence(series)).toHaveLength(0);
  });

  it("reports invalid candle by index", () => {
    const series = candleSeries(5);
    series[2] = candle({ time: series[2]!.time, high: 50, low: 200 }); // invalid
    const report = validateOHLCSequence(series);
    expect(report.some((e) => e.index === 2)).toBe(true);
  });

  it("detects duplicate timestamps across the series", () => {
    const series = candleSeries(5);
    series[3] = { ...series[3]!, time: series[1]!.time }; // duplicate of index 1
    const report = validateOHLCSequence(series);
    expect(report.some((e) => e.errors.includes("DUPLICATE_TIMESTAMP"))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. OUTLIER / ANOMALY DETECTION
// ═════════════════════════════════════════════════════════════════════════════

describe("computeATR()", () => {
  it("returns null for fewer than 2 candles", () => {
    expect(computeATR([])).toBeNull();
    expect(computeATR([candle()])).toBeNull();
  });

  it("computes a positive ATR for a normal series", () => {
    const series = candleSeries(20);
    const atr = computeATR(series);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);
  });

  it("uses only the last `period` candles", () => {
    const long = candleSeries(100);
    const short = long.slice(-14);
    expect(computeATR(long, 14)).toBeCloseTo(computeATR(short, 14)!, 6);
  });
});

describe("computeVolatility()", () => {
  it("returns null for fewer than 2 candles", () => {
    expect(computeVolatility([])).toBeNull();
    expect(computeVolatility([candle()])).toBeNull();
  });

  it("returns 0 for a flat-price series", () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      time: 1_700_000_000 + i * 60,
      open: 100,
      high: 105,
      low: 95,
      close: 100, // identical closes → σ = 0
      volume: 1_000,
    }));
    expect(computeVolatility(flat)).toBeCloseTo(0, 8);
  });

  it("returns a higher value for a volatile series", () => {
    const volatile = candleSeries(20).map((c, i) => ({
      ...c,
      close: i % 2 === 0 ? 80 : 120, // oscillating
    }));
    const vol = computeVolatility(volatile);
    expect(vol!).toBeGreaterThan(0.1);
  });
});

describe("detectOutlier()", () => {
  it("returns anomalyScore 0 when there are no reference candles", () => {
    const r = detectOutlier(100, []);
    expect(r.anomalyScore).toBe(0);
    expect(r.isOutlier).toBe(false);
    expect(r.reason).toBe("NORMAL");
  });

  it("returns NORMAL for a modest price move", () => {
    const series = candleSeries(20, 100); // last close = 121
    const lastClose = series[series.length - 1]!.close; // 121
    const newPrice = lastClose * 1.005; // +0.5% — clearly modest
    const r = detectOutlier(newPrice, series);
    expect(r.isOutlier).toBe(false);
    expect(r.reason).toBe("NORMAL");
  });

  it("flash crash simulation — flags a 20% sudden drop as an outlier", () => {
    // Stable series at ~100
    const series = candleSeries(20, 100);
    // Price craters by 20 %
    const flashPrice = series[series.length - 1]!.close * 0.80;
    const r = detectOutlier(flashPrice, series);
    expect(r.isOutlier).toBe(true);
    expect(r.anomalyScore).toBeGreaterThanOrEqual(0.7);
  });

  it("high-volatility valid move — does NOT flag a large move in a volatile session", () => {
    // Build a genuinely volatile series where a 12% move is within normal range
    const volatileSeries = Array.from({ length: 30 }, (_, i) => {
      const base = 100 + (i % 2 === 0 ? 10 : -10); // ±10% swing each candle
      return {
        time: 1_700_000_000 + i * 60,
        open: base,
        high: base + 12,
        low: base - 12,
        close: base + (i % 3 === 0 ? 10 : -5),
        volume: 10_000,
      };
    });
    const lastClose = volatileSeries[volatileSeries.length - 1]!.close;
    // A 12% move in a session where ±10% is normal
    const r = detectOutlier(lastClose * 1.12, volatileSeries);
    // Anomaly score should be attenuated by high volatility
    expect(r.isOutlier).toBe(false);
  });

  it("anomalyScore is in [0, 1]", () => {
    const series = candleSeries(20, 100);
    const r = detectOutlier(1, series); // extreme drop
    expect(r.anomalyScore).toBeGreaterThanOrEqual(0);
    expect(r.anomalyScore).toBeLessThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. QUALITY ENVELOPE / SOURCE CONFIDENCE
// ═════════════════════════════════════════════════════════════════════════════

describe("buildQualityEnvelope()", () => {
  const noOutlier: OutlierResult = { anomalyScore: 0, isOutlier: false, reason: "NORMAL" };
  const outlier: OutlierResult = { anomalyScore: 0.9, isOutlier: true, reason: "PCT_MOVE_BREACH" };

  it("VALID: fresh, no outlier, providers agree", () => {
    const q = buildQualityEnvelope({
      source: "angel_one",
      stale: false,
      outlier: noOutlier,
      crossProviderAnomaly: false,
      structurallyValid: true,
    });
    expect(q.validationStatus).toBe("VALID");
    expect(q.qualityScore).toBe(1.0);
    expect(q.source).toBe("angel_one");
  });

  it("STALE: stale tick reduces score and sets STALE status", () => {
    const q = buildQualityEnvelope({
      source: "upstox",
      stale: true,
      outlier: noOutlier,
      crossProviderAnomaly: false,
      structurallyValid: true,
    });
    expect(q.validationStatus).toBe("STALE");
    expect(q.qualityScore).toBeLessThan(1.0);
  });

  it("INVALID: structurally invalid forces qualityScore=0 and INVALID status", () => {
    const q = buildQualityEnvelope({
      source: "nse",
      stale: false,
      outlier: noOutlier,
      crossProviderAnomaly: false,
      structurallyValid: false,
    });
    expect(q.validationStatus).toBe("INVALID");
    expect(q.qualityScore).toBe(0);
  });

  it("SUSPICIOUS: outlier sets SUSPICIOUS status", () => {
    const q = buildQualityEnvelope({
      source: "yahoo",
      stale: false,
      outlier,
      crossProviderAnomaly: false,
      structurallyValid: true,
    });
    expect(q.validationStatus).toBe("SUSPICIOUS");
  });

  it("SUSPICIOUS: cross-provider anomaly sets SUSPICIOUS status", () => {
    const q = buildQualityEnvelope({
      source: "angel_one",
      stale: false,
      outlier: noOutlier,
      crossProviderAnomaly: true,
      structurallyValid: true,
    });
    expect(q.validationStatus).toBe("SUSPICIOUS");
  });

  it("UNVERIFIED: null cross-provider (only one provider available)", () => {
    const q = buildQualityEnvelope({
      source: "angel_one",
      stale: false,
      outlier: noOutlier,
      crossProviderAnomaly: null,
      structurallyValid: true,
    });
    expect(q.validationStatus).toBe("UNVERIFIED");
    expect(q.qualityScore).toBeLessThan(1.0); // small penalty for no cross-validation
    expect(q.qualityScore).toBeGreaterThan(0.9);
  });

  it("qualityScore is always in [0, 1]", () => {
    // Worst case: stale + outlier + cross-provider anomaly
    const q = buildQualityEnvelope({
      source: "yahoo",
      stale: true,
      outlier,
      crossProviderAnomaly: true,
      structurallyValid: true,
    });
    expect(q.qualityScore).toBeGreaterThanOrEqual(0);
    expect(q.qualityScore).toBeLessThanOrEqual(1);
  });

  it("STALE takes precedence over SUSPICIOUS when both conditions exist", () => {
    // Stale AND outlier → should be STALE (staleness takes precedence per spec)
    const q = buildQualityEnvelope({
      source: "upstox",
      stale: true,
      outlier,
      crossProviderAnomaly: false,
      structurallyValid: true,
    });
    expect(q.validationStatus).toBe("STALE");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PROVIDER HEALTH SCORE
// ═════════════════════════════════════════════════════════════════════════════

describe("computeProviderHealthScore()", () => {
  const provider: ProviderId = "angel_one";

  it("returns score 100 for a fresh provider with no recorded events", () => {
    const snap = computeProviderHealthScore(provider);
    expect(snap.score).toBe(100);
    expect(snap.latencyMs).toBeNull();
  });

  it("reduces score when errors are recorded", () => {
    for (let i = 0; i < 30; i++) recordProviderError(provider);
    const snap = computeProviderHealthScore(provider);
    expect(snap.errorRate).toBeGreaterThan(0);
    expect(snap.score).toBeLessThan(100);
  });

  it("reduces score when stale events are recorded via checkTickStaleness", () => {
    const stale = tick({
      provider,
      exchangeTimestampMs: NOW - 20_000,
      receivedAtMs: NOW - 20_000,
    });
    checkTickStaleness(stale, undefined, NOW);
    const snap = computeProviderHealthScore(provider);
    expect(snap.staleRate).toBeGreaterThan(0);
    expect(snap.score).toBeLessThan(100);
  });

  it("reduces score for WS disconnects", () => {
    for (let i = 0; i < 10; i++) recordWsDisconnect(provider);
    const snap = computeProviderHealthScore(provider);
    expect(snap.wsDisconnectRate).toBeGreaterThan(0);
    expect(snap.score).toBeLessThan(100);
  });

  it("recovers score when provider recovers after disconnects", () => {
    for (let i = 0; i < 10; i++) recordWsDisconnect(provider);
    const before = computeProviderHealthScore(provider).score;
    for (let i = 0; i < 10; i++) recordWsRecovery(provider);
    const after = computeProviderHealthScore(provider).score;
    expect(after).toBeGreaterThan(before);
  });

  it("captures latency in snapshot", () => {
    recordProviderLatency(provider, 50);
    recordProviderLatency(provider, 80);
    recordProviderLatency(provider, 120);
    const snap = computeProviderHealthScore(provider);
    expect(snap.latencyMs).not.toBeNull();
    expect(snap.latencyMs!).toBeGreaterThan(0);
  });

  it("penalises high latency (P95 > 100ms)", () => {
    // Record 100 samples all at 400ms to drive P95 way up
    for (let i = 0; i < 100; i++) recordProviderLatency(provider, 400);
    const snap = computeProviderHealthScore(provider);
    expect(snap.score).toBeLessThan(100);
  });

  it("score is always in [0, 100]", () => {
    for (let i = 0; i < 200; i++) recordProviderError(provider);
    const snap = computeProviderHealthScore(provider);
    expect(snap.score).toBeGreaterThanOrEqual(0);
    expect(snap.score).toBeLessThanOrEqual(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 & 8. SAFETY GATES — AI and PAPER TRADING
// ═════════════════════════════════════════════════════════════════════════════

describe("evaluateSafetyGate()", () => {
  function envelope(status: QualityEnvelope["validationStatus"]): QualityEnvelope {
    return { source: "angel_one", qualityScore: 0.9, validationStatus: status };
  }

  describe("AI safety gate", () => {
    it("VALID → allowAI = true", () => {
      expect(evaluateSafetyGate(envelope("VALID")).allowAI).toBe(true);
    });

    it("UNVERIFIED → allowAI = true", () => {
      expect(evaluateSafetyGate(envelope("UNVERIFIED")).allowAI).toBe(true);
    });

    it("STALE → allowAI = false", () => {
      expect(evaluateSafetyGate(envelope("STALE")).allowAI).toBe(false);
    });

    it("INVALID → allowAI = false", () => {
      expect(evaluateSafetyGate(envelope("INVALID")).allowAI).toBe(false);
    });

    it("SUSPICIOUS → allowAI = false by default", () => {
      expect(evaluateSafetyGate(envelope("SUSPICIOUS")).allowAI).toBe(false);
    });

    it("SUSPICIOUS → allowAI = true when allowSuspiciousForAI = true", () => {
      const config: ReconciliationConfig = { allowSuspiciousForAI: true };
      expect(evaluateSafetyGate(envelope("SUSPICIOUS"), config).allowAI).toBe(true);
    });
  });

  describe("paper trading safety gate", () => {
    it("VALID → allowPaperTrade = true", () => {
      expect(evaluateSafetyGate(envelope("VALID")).allowPaperTrade).toBe(true);
    });

    it("STALE → allowPaperTrade = false", () => {
      expect(evaluateSafetyGate(envelope("STALE")).allowPaperTrade).toBe(false);
    });

    it("INVALID → allowPaperTrade = false", () => {
      expect(evaluateSafetyGate(envelope("INVALID")).allowPaperTrade).toBe(false);
    });

    it("SUSPICIOUS → allowPaperTrade = true (paper trading tolerates suspicious)", () => {
      expect(evaluateSafetyGate(envelope("SUSPICIOUS")).allowPaperTrade).toBe(true);
    });

    it("UNVERIFIED → allowPaperTrade = true", () => {
      expect(evaluateSafetyGate(envelope("UNVERIFIED")).allowPaperTrade).toBe(true);
    });
  });

  it("provides a non-empty reason when data is blocked", () => {
    const result = evaluateSafetyGate(envelope("STALE"));
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("provides a reason when data is allowed", () => {
    const result = evaluateSafetyGate(envelope("VALID"));
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE — reconcileTick()
// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileTick()", () => {
  it("returns VALID for a clean fresh tick with provider agreement", () => {
    const t = tick({ ltp: 2900, exchangeTimestampMs: NOW - 1_000, receivedAtMs: NOW - 500 });
    const result = reconcileTick({
      tick: t,
      secondProviderPrice: { provider: "upstox", price: 2900.5 },
      now: NOW,
    });
    expect(result.quality.validationStatus).toBe("VALID");
    expect(result.quality.qualityScore).toBe(1.0);
    expect(result.data).toBe(t);
  });

  it("returns STALE for a tick with old exchange timestamp", () => {
    const t = tick({ exchangeTimestampMs: NOW - 30_000, receivedAtMs: NOW - 30_000 });
    const result = reconcileTick({ tick: t, now: NOW });
    expect(result.quality.validationStatus).toBe("STALE");
  });

  it("returns SUSPICIOUS when cross-provider prices diverge significantly", () => {
    const t = tick({ ltp: 245.50, instrumentCategory: "STOCK" });
    const result = reconcileTick({
      tick: t,
      secondProviderPrice: { provider: "upstox", price: 252.80 },
      now: NOW,
    });
    expect(result.quality.validationStatus).toBe("SUSPICIOUS");
  });

  it("returns UNVERIFIED when no second provider is available", () => {
    const t = tick();
    const result = reconcileTick({ tick: t, now: NOW });
    expect(result.quality.validationStatus).toBe("UNVERIFIED");
  });

  it("preserves the original tick data reference", () => {
    const t = tick();
    const result = reconcileTick({ tick: t, now: NOW });
    expect(result.data).toBe(t);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE — reconcileCandle()
// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileCandle()", () => {
  it("returns VALID for a structurally sound candle", () => {
    const c = candle();
    const result = reconcileCandle({ candle: c, provider: "angel_one" });
    expect(result.quality.validationStatus).not.toBe("INVALID");
    expect(result.data).toBe(c);
  });

  it("returns INVALID for a candle with high < low", () => {
    const c = candle({ high: 90, low: 95, open: 92, close: 91 });
    const result = reconcileCandle({ candle: c, provider: "angel_one" });
    expect(result.quality.validationStatus).toBe("INVALID");
    expect(result.quality.qualityScore).toBe(0);
  });

  it("returns INVALID for a candle with open outside high/low", () => {
    const c = candle({ open: 115 }); // open > high (110)
    const result = reconcileCandle({ candle: c, provider: "upstox" });
    expect(result.quality.validationStatus).toBe("INVALID");
  });

  it("returns INVALID for a candle with close outside high/low", () => {
    const c = candle({ close: 90, low: 95 }); // close < low
    const result = reconcileCandle({ candle: c, provider: "nse" });
    expect(result.quality.validationStatus).toBe("INVALID");
  });

  it("returns INVALID for a candle with negative volume", () => {
    const c = candle({ volume: -100 });
    const result = reconcileCandle({ candle: c, provider: "yahoo" });
    expect(result.quality.validationStatus).toBe("INVALID");
  });

  it("detects duplicate timestamps when seenTimestamps is provided", () => {
    const seen = new Set<number>();
    const c = candle({ time: 1_700_000_000 });
    reconcileCandle({ candle: c, provider: "angel_one", seenTimestamps: seen });
    const dup = reconcileCandle({ candle: c, provider: "angel_one", seenTimestamps: seen });
    expect(dup.quality.validationStatus).toBe("INVALID");
  });

  it("returns SUSPICIOUS for a flash-crash candle close (vs recent history)", () => {
    // Stable series around 100, then close at 75 (25% drop)
    const series = candleSeries(20, 100);
    const crashCandle: OHLCVCandle = {
      time: series[series.length - 1]!.time + 60,
      open: 100,
      high: 101,
      low: 74,
      close: 75,
      volume: 50_000,
    };
    const result = reconcileCandle({
      candle: crashCandle,
      provider: "angel_one",
      recentCandles: series,
    });
    expect(result.quality.validationStatus).toBe("SUSPICIOUS");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROVIDER RECOVERY SCENARIO
// ═════════════════════════════════════════════════════════════════════════════

describe("Provider recovery scenario", () => {
  const provider: ProviderId = "upstox";

  it("health score recovers after WS reconnects following disconnects", () => {
    // Step 1: Trigger disconnects to degrade health
    for (let i = 0; i < 20; i++) recordWsDisconnect(provider);
    const degraded = computeProviderHealthScore(provider);
    expect(degraded.score).toBeLessThan(100);
    expect(degraded.wsDisconnectRate).toBeGreaterThan(0.5);

    // Step 2: Provider recovers — reconnections start succeeding
    for (let i = 0; i < 30; i++) recordWsRecovery(provider);
    const recovered = computeProviderHealthScore(provider);
    expect(recovered.score).toBeGreaterThan(degraded.score);
    expect(recovered.recoveryRate).toBeGreaterThan(0.5);
  });

  it("ticks from a recovered provider qualify as VALID", () => {
    for (let i = 0; i < 10; i++) recordWsRecovery(provider);
    const t = tick({
      provider,
      exchangeTimestampMs: NOW - 1_000,
      receivedAtMs: NOW - 500,
      ltp: 500,
      instrumentCategory: "STOCK",
    });
    const result = reconcileTick({
      tick: t,
      secondProviderPrice: { provider: "angel_one", price: 500.5 },
      now: NOW,
    });
    expect(result.quality.validationStatus).toBe("VALID");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFAULT THRESHOLDS — sanity checks
// ═════════════════════════════════════════════════════════════════════════════

describe("Default thresholds", () => {
  it("LIVE_TICK_MAX_AGE_MS is 5s", () => {
    expect(DEFAULT_STALE_THRESHOLDS_MS.LIVE_TICK_MAX_AGE_MS).toBe(5_000);
  });

  it("QUOTE_MAX_AGE_MS is 10s", () => {
    expect(DEFAULT_STALE_THRESHOLDS_MS.QUOTE_MAX_AGE_MS).toBe(10_000);
  });

  it("OPTION_CHAIN_MAX_AGE_MS is 30s", () => {
    expect(DEFAULT_STALE_THRESHOLDS_MS.OPTION_CHAIN_MAX_AGE_MS).toBe(30_000);
  });

  it("INDEX threshold is stricter than STOCK", () => {
    expect(DEFAULT_DIVERGENCE_THRESHOLDS_PCT.INDEX)
      .toBeLessThan(DEFAULT_DIVERGENCE_THRESHOLDS_PCT.STOCK);
  });

  it("OPTION threshold is the widest", () => {
    const all = Object.values(DEFAULT_DIVERGENCE_THRESHOLDS_PCT);
    expect(DEFAULT_DIVERGENCE_THRESHOLDS_PCT.OPTION).toBe(Math.max(...all));
  });
});
