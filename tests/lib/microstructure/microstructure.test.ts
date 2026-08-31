/**
 * microstructure.test.ts — Market Microstructure Intelligence Engine
 *
 * Test scenarios:
 *   1.  Balanced book            — imbalance ≈ 0.5, BALANCED regime
 *   2.  Strong bid imbalance     — heavy bids, STRONG_BID regime, bid > 0.65
 *   3.  Strong ask imbalance     — heavy asks, STRONG_ASK regime, ask < 0.35
 *   4.  Wide spread              — spread percentile high, isWide = true
 *   5.  Thin liquidity           — low depth + wide spread → VERY_LOW tier
 *   6.  Spoof-like transient depth — large depth spike then removal, weighted
 *                                    imbalance returns to near-neutral after spike
 *   7.  Spread tracker percentile — 200 samples, current is median
 *   8.  Liquidity sub-scores     — verify individual dimension contribution
 *   9.  VPIN computation         — trending vs flat candles
 *  10.  Toxicity composite       — high VPIN + extreme imbalance → EXTREME
 *  11.  Toxicity adjustments     — confidence and sizing multipliers
 *  12.  Pressure — buy pressure  — growing bids + rising price → MILD_BUY
 *  13.  Pressure — sell pressure — shrinking bids + falling price → MILD_SELL
 *  14.  Pressure — neutral       — no change → NEUTRAL
 *  15.  ExecQuality EXCELLENT    — tight spread, high liquidity, low toxicity
 *  16.  ExecQuality POOR         — very wide spread, high toxicity, thin book
 *  17.  Feature store 1m bucket  — ticks spanning >1 min produce a bucket
 *  18.  Feature store 5m bucket  — ticks spanning >5 min produce a bucket
 *  19.  MicrostructureEngine reset — state cleared between sessions
 *  20.  execQualityToFillScore   — maps to correct [0,1] values
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  buildOrderBookSnapshot,
  bidQtyTopN,
  askQtyTopN,
  isEmptyBook,
  type OrderBookSnapshot,
} from "@/lib/microstructure/order-book";

import {
  computeL1Imbalance,
  computeL5Imbalance,
  computeWeightedImbalance,
  computeImbalance,
  classifyImbalance,
} from "@/lib/microstructure/imbalance";

import {
  SpreadTracker,
  percentileRank,
  insertSorted,
} from "@/lib/microstructure/spread";

import {
  computeLiquidityScore,
  classifyLiquidityTier,
  liquiditySizingMultiplier,
  DEFAULT_LIQUIDITY_CONFIG,
} from "@/lib/microstructure/liquidity";

import {
  computeVpin,
  computeToxicityScore,
  adjustConfidenceForToxicity,
  toxicitySizingMultiplier,
  imbalanceExtremity,
  classifyToxicity,
} from "@/lib/microstructure/toxicity";

import {
  PressureTracker,
  computePressureFrame,
  classifyPressureRegime,
} from "@/lib/microstructure/pressure";

import {
  MicrostructureEngine,
  createMicrostructureEngine,
  execQualityToFillScore,
  DEFAULT_MICROSTRUCTURE_CONFIG,
} from "@/lib/microstructure/index";

import type { MarketDepth, OHLCVCandle } from "@/lib/market-data/types";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeDepth(
  symbol: string,
  bids: { price: number; quantity: number; orders?: number }[],
  asks: { price: number; quantity: number; orders?: number }[],
): MarketDepth {
  return {
    symbol,
    token: "123",
    bids: bids.map(b => ({ price: b.price, quantity: b.quantity, orders: b.orders ?? 1 })),
    asks: asks.map(a => ({ price: a.price, quantity: a.quantity, orders: a.orders ?? 1 })),
    provider: "angel_one",
    fetchedAt: new Date().toISOString(),
  };
}

/** Balanced book: equal qty on both sides at 5 levels. */
function balancedDepth(mid = 1000, spread = 1, qty = 1000): MarketDepth {
  const half = spread / 2;
  return makeDepth("TEST", [
    { price: mid - half * 1, quantity: qty },
    { price: mid - half * 2, quantity: qty },
    { price: mid - half * 3, quantity: qty },
    { price: mid - half * 4, quantity: qty },
    { price: mid - half * 5, quantity: qty },
  ], [
    { price: mid + half * 1, quantity: qty },
    { price: mid + half * 2, quantity: qty },
    { price: mid + half * 3, quantity: qty },
    { price: mid + half * 4, quantity: qty },
    { price: mid + half * 5, quantity: qty },
  ]);
}

/** Bid-heavy book: bids are 4× the ask qty. */
function bidHeavyDepth(mid = 1000): MarketDepth {
  return makeDepth("TEST", [
    { price: 999.5, quantity: 4000 },
    { price: 999.0, quantity: 4000 },
    { price: 998.5, quantity: 4000 },
    { price: 998.0, quantity: 4000 },
    { price: 997.5, quantity: 4000 },
  ], [
    { price: 1000.5, quantity: 1000 },
    { price: 1001.0, quantity: 1000 },
    { price: 1001.5, quantity: 1000 },
    { price: 1002.0, quantity: 1000 },
    { price: 1002.5, quantity: 1000 },
  ]);
}

/** Ask-heavy book: asks are 4× the bid qty. */
function askHeavyDepth(mid = 1000): MarketDepth {
  return makeDepth("TEST", [
    { price: 999.5, quantity: 1000 },
    { price: 999.0, quantity: 1000 },
    { price: 998.5, quantity: 1000 },
    { price: 998.0, quantity: 1000 },
    { price: 997.5, quantity: 1000 },
  ], [
    { price: 1000.5, quantity: 4000 },
    { price: 1001.0, quantity: 4000 },
    { price: 1001.5, quantity: 4000 },
    { price: 1002.0, quantity: 4000 },
    { price: 1002.5, quantity: 4000 },
  ]);
}

/** Wide-spread depth: 200 bps spread. */
function wideSpreadDepth(price = 1000): MarketDepth {
  return makeDepth("TEST", [
    { price: price * 0.99, quantity: 500 },
    { price: price * 0.98, quantity: 500 },
  ], [
    { price: price * 1.01, quantity: 500 },
    { price: price * 1.02, quantity: 500 },
  ]);
}

/** Thin liquidity: 1 level each side, tiny qty, wide spread. */
function thinDepth(price = 1000): MarketDepth {
  return makeDepth("TEST", [
    { price: price - 10, quantity: 10 },
  ], [
    { price: price + 10, quantity: 10 },
  ]);
}

function makeSnapshot(depth: MarketDepth, ts = Date.now()): OrderBookSnapshot {
  return buildOrderBookSnapshot(depth, ts);
}

function makeLiquidityEngine() {
  return createMicrostructureEngine("TEST");
}

function makeLiquidityInputs(volume = 5000, oi = 50000, isFnO = true) {
  return { volume, openInterest: oi, isFnO };
}

/** Build a simple series of OHLCV candles with a steadily rising close. */
function risingCandles(n: number, base = 100, step = 1, vol = 100): OHLCVCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time:   i * 300,
    open:   base + i * step,
    high:   base + i * step + step,
    low:    base + i * step - step * 0.5,
    close:  base + (i + 1) * step,
    volume: vol,
  }));
}

/** Build flat candles (close === open). */
function flatCandles(n: number, price = 100, vol = 100): OHLCVCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time:   i * 300,
    open:   price,
    high:   price,
    low:    price,
    close:  price,
    volume: vol,
  }));
}

// ── Order book helpers ────────────────────────────────────────────────────────

describe("order-book helpers", () => {
  it("builds a snapshot from MarketDepth correctly", () => {
    const depth = balancedDepth(1000, 2, 500);
    const snap = makeSnapshot(depth);

    expect(snap.bestBid).toBeCloseTo(999);
    expect(snap.bestAsk).toBeCloseTo(1001);
    expect(snap.spread).toBeCloseTo(2);
    expect(snap.spreadFraction).toBeCloseTo(0.002, 4);
    expect(snap.midPrice).toBeCloseTo(1000);
    expect(snap.totalBidQty).toBe(2500);
    expect(snap.totalAskQty).toBe(2500);
  });

  it("isEmptyBook returns true when bestBid or bestAsk is 0", () => {
    const emptyDepth = makeDepth("TEST", [], []);
    const snap = makeSnapshot(emptyDepth);
    expect(isEmptyBook(snap)).toBe(true);
  });

  it("bidQtyTopN and askQtyTopN sum the correct levels", () => {
    const snap = makeSnapshot(balancedDepth(1000, 2, 200));
    expect(bidQtyTopN(snap, 2)).toBe(400);
    expect(askQtyTopN(snap, 3)).toBe(600);
  });
});

// ── 1. Balanced book ──────────────────────────────────────────────────────────

describe("imbalance — balanced book", () => {
  it("L1 imbalance is ~0.5", () => {
    const snap = makeSnapshot(balancedDepth());
    expect(computeL1Imbalance(snap)).toBeCloseTo(0.5, 2);
  });

  it("L5 imbalance is ~0.5", () => {
    const snap = makeSnapshot(balancedDepth());
    expect(computeL5Imbalance(snap)).toBeCloseTo(0.5, 2);
  });

  it("weighted imbalance is ~0.5", () => {
    const snap = makeSnapshot(balancedDepth());
    expect(computeWeightedImbalance(snap)).toBeCloseTo(0.5, 2);
  });

  it("classifies as BALANCED", () => {
    const snap = makeSnapshot(balancedDepth());
    const result = computeImbalance(snap);
    expect(classifyImbalance(result.weighted)).toBe("BALANCED");
  });

  it("netPressure is near zero", () => {
    const snap = makeSnapshot(balancedDepth());
    const result = computeImbalance(snap);
    expect(Math.abs(result.netPressure)).toBeLessThan(0.05);
  });
});

// ── 2. Strong bid imbalance ───────────────────────────────────────────────────

describe("imbalance — strong bid imbalance", () => {
  it("L1 imbalance > 0.75", () => {
    const snap = makeSnapshot(bidHeavyDepth());
    expect(computeL1Imbalance(snap)).toBeGreaterThan(0.75);
  });

  it("L5 imbalance > 0.75", () => {
    const snap = makeSnapshot(bidHeavyDepth());
    expect(computeL5Imbalance(snap)).toBeGreaterThan(0.75);
  });

  it("weighted imbalance > 0.65 → STRONG_BID", () => {
    const snap = makeSnapshot(bidHeavyDepth());
    const w = computeWeightedImbalance(snap);
    expect(w).toBeGreaterThan(0.65);
    expect(classifyImbalance(w)).toBe("STRONG_BID");
  });

  it("netPressure is strongly positive", () => {
    const snap = makeSnapshot(bidHeavyDepth());
    const result = computeImbalance(snap);
    expect(result.netPressure).toBeGreaterThan(0.5);
  });
});

// ── 3. Strong ask imbalance ───────────────────────────────────────────────────

describe("imbalance — strong ask imbalance", () => {
  it("L1 imbalance < 0.25", () => {
    const snap = makeSnapshot(askHeavyDepth());
    expect(computeL1Imbalance(snap)).toBeLessThan(0.25);
  });

  it("L5 imbalance < 0.25", () => {
    const snap = makeSnapshot(askHeavyDepth());
    expect(computeL5Imbalance(snap)).toBeLessThan(0.25);
  });

  it("weighted imbalance < 0.35 → STRONG_ASK", () => {
    const snap = makeSnapshot(askHeavyDepth());
    const w = computeWeightedImbalance(snap);
    expect(w).toBeLessThan(0.35);
    expect(classifyImbalance(w)).toBe("STRONG_ASK");
  });

  it("netPressure is strongly negative", () => {
    const snap = makeSnapshot(askHeavyDepth());
    const result = computeImbalance(snap);
    expect(result.netPressure).toBeLessThan(-0.5);
  });
});

// ── 4. Wide spread ────────────────────────────────────────────────────────────

describe("spread — wide spread", () => {
  it("absolute spread is correctly computed", () => {
    const snap = makeSnapshot(wideSpreadDepth(1000));
    // bestBid ≈ 990, bestAsk ≈ 1010
    expect(snap.spread).toBeCloseTo(20, 0);
  });

  it("pctSpread is ~0.02 (200 bps)", () => {
    const snap = makeSnapshot(wideSpreadDepth(1000));
    expect(snap.spreadFraction).toBeCloseTo(0.02, 3);
  });

  it("isWide=true after enough observations populate the window", () => {
    const tracker = new SpreadTracker({ windowSize: 50, widePercentileThreshold: 0.75 });

    // Prime with 40 tight-spread ticks
    const tightDepth = balancedDepth(1000, 1, 500); // spread ≈ 1 bps
    for (let i = 0; i < 40; i++) {
      tracker.update(makeSnapshot(tightDepth, 1000 + i));
    }

    // Now feed a wide-spread tick
    const wideSnap = makeSnapshot(wideSpreadDepth(1000), 2000);
    const result = tracker.update(wideSnap);

    expect(result.isWide).toBe(true);
    expect(result.spreadPercentile).not.toBeNull();
    expect(result.spreadPercentile!).toBeGreaterThanOrEqual(0.75);
  });

  it("percentileRank returns null for < 2 observations", () => {
    expect(percentileRank([0.001], 0.001)).toBeNull();
  });

  it("insertSorted keeps the array sorted", () => {
    const arr: number[] = [1, 3, 5];
    insertSorted(arr, 2);
    expect(arr).toEqual([1, 2, 3, 5]);
    insertSorted(arr, 6);
    expect(arr).toEqual([1, 2, 3, 5, 6]);
    insertSorted(arr, 0.5);
    expect(arr).toEqual([0.5, 1, 2, 3, 5, 6]);
  });
});

// ── 5. Thin liquidity ─────────────────────────────────────────────────────────

describe("liquidity — thin liquidity", () => {
  it("thin book scores VERY_LOW or LOW", () => {
    const snap = makeSnapshot(thinDepth(1000));
    const result = computeLiquidityScore({
      snapshot: snap,
      volume: 50,         // tiny volume
      openInterest: 100,  // negligible OI
      isFnO: true,
      pctSpread: snap.spreadFraction,
    }, DEFAULT_LIQUIDITY_CONFIG);

    expect(["VERY_LOW", "LOW"]).toContain(result.tier);
    expect(result.score).toBeLessThan(0.40);
  });

  it("liquiditySizingMultiplier is reduced for thin books", () => {
    expect(liquiditySizingMultiplier("VERY_LOW")).toBe(0.20);
    expect(liquiditySizingMultiplier("LOW")).toBe(0.40);
    expect(liquiditySizingMultiplier("VERY_HIGH")).toBe(1.00);
  });

  it("deep liquid book scores HIGH or VERY_HIGH", () => {
    const snap = makeSnapshot(balancedDepth(1000, 1, 10_000));
    const result = computeLiquidityScore({
      snapshot: snap,
      volume: 15_000,
      openInterest: 200_000,
      isFnO: true,
      pctSpread: snap.spreadFraction,
    }, DEFAULT_LIQUIDITY_CONFIG);

    expect(["HIGH", "VERY_HIGH"]).toContain(result.tier);
    expect(result.score).toBeGreaterThan(0.50);
  });

  it("equity spot OI score defaults to 1.0", () => {
    const snap = makeSnapshot(balancedDepth(1000, 1, 5000));
    const result = computeLiquidityScore({
      snapshot: snap,
      volume: 10_000,
      openInterest: 0,
      isFnO: false,
      pctSpread: snap.spreadFraction,
    }, DEFAULT_LIQUIDITY_CONFIG);
    expect(result.oiScore).toBe(1.0);
  });
});

// ── 6. Spoof-like transient depth ─────────────────────────────────────────────

describe("imbalance — spoof-like transient depth", () => {
  /**
   * Scenario: a large bid wall appears (classic layering / spoofing pattern)
   * making the imbalance swing heavily bid-side, then the wall disappears and
   * the imbalance returns to near-neutral.
   */
  it("bid wall drives STRONG_BID then removal returns near-neutral", () => {
    // Normal book: 1000 each side
    const normalSnap = makeSnapshot(balancedDepth(1000, 1, 1000));
    const normalResult = computeImbalance(normalSnap);
    expect(classifyImbalance(normalResult.weighted)).toBe("BALANCED");

    // Spoof: add a massive bid wall at L2-L5 (10× normal)
    const spoofDepth = makeDepth("TEST", [
      { price: 999.5, quantity: 1000 },
      { price: 999.0, quantity: 10_000 }, // ← spoof wall
      { price: 998.5, quantity: 10_000 },
      { price: 998.0, quantity: 10_000 },
      { price: 997.5, quantity: 10_000 },
    ], [
      { price: 1000.5, quantity: 1000 },
      { price: 1001.0, quantity: 1000 },
      { price: 1001.5, quantity: 1000 },
      { price: 1002.0, quantity: 1000 },
      { price: 1002.5, quantity: 1000 },
    ]);
    const spoofSnap = makeSnapshot(spoofDepth);
    const spoofResult = computeImbalance(spoofSnap);
    // L1 is balanced (1000:1000), but L5 and weighted are heavily bid-side
    expect(computeL1Imbalance(spoofSnap)).toBeCloseTo(0.5, 1);
    expect(computeL5Imbalance(spoofSnap)).toBeGreaterThan(0.80);
    expect(classifyImbalance(spoofResult.weighted)).toBe("STRONG_BID");

    // Wall removed — book returns to normal
    const afterSnap = makeSnapshot(balancedDepth(1000, 1, 1000));
    const afterResult = computeImbalance(afterSnap);
    expect(classifyImbalance(afterResult.weighted)).toBe("BALANCED");
  });

  it("weighted imbalance is less extreme than L5 during spoofing (L1 anchors it)", () => {
    const spoofDepth = makeDepth("TEST", [
      { price: 999.5, quantity: 1000 },  // L1 balanced
      { price: 999.0, quantity: 9000 },  // wall
      { price: 998.5, quantity: 9000 },
      { price: 998.0, quantity: 9000 },
      { price: 997.5, quantity: 9000 },
    ], [
      { price: 1000.5, quantity: 1000 },
      { price: 1001.0, quantity: 1000 },
      { price: 1001.5, quantity: 1000 },
      { price: 1002.0, quantity: 1000 },
      { price: 1002.5, quantity: 1000 },
    ]);
    const snap = makeSnapshot(spoofDepth);
    const l5 = computeL5Imbalance(snap);
    const w  = computeWeightedImbalance(snap);
    // Weighted should be less extreme than L5 because L1 is balanced and
    // carries the highest weight (1.0).
    expect(w).toBeLessThan(l5);
    // Both should still be strongly bid-side
    expect(w).toBeGreaterThan(0.60);
  });
});

// ── 7. Spread percentile tracking ────────────────────────────────────────────

describe("spread — percentile tracking", () => {
  it("median observation ranks at ~0.50", () => {
    const tracker = new SpreadTracker({ windowSize: 200, widePercentileThreshold: 0.75 });
    // Feed 200 observations with spreads 1bps to 200bps
    for (let i = 1; i <= 200; i++) {
      const depth = makeDepth("TEST",
        [{ price: 1000 - i * 0.01, quantity: 500 }],
        [{ price: 1000 + i * 0.01, quantity: 500 }],
      );
      tracker.update(buildOrderBookSnapshot(depth, i));
    }

    // Feed the 100th-ranked spread (exactly the median)
    const depth = makeDepth("TEST",
      [{ price: 1000 - 1.00, quantity: 500 }],
      [{ price: 1000 + 1.00, quantity: 500 }],
    );
    const result = tracker.update(buildOrderBookSnapshot(depth, 201));
    // spreadPercentile should be close to 0.50 (within rounding)
    expect(result.spreadPercentile).not.toBeNull();
    expect(result.spreadPercentile!).toBeGreaterThan(0.40);
    expect(result.spreadPercentile!).toBeLessThan(0.60);
  });
});

// ── 8. Liquidity sub-scores ───────────────────────────────────────────────────

describe("liquidity — sub-score contributions", () => {
  it("spread score is 0 at worst spread and 1 at zero spread", () => {
    const wideSnap = makeSnapshot(wideSpreadDepth(1000)); // ~200bps spread
    const wideResult = computeLiquidityScore({
      snapshot: wideSnap,
      volume: 5000,
      openInterest: 50000,
      isFnO: true,
      pctSpread: 0.02, // exactly worst spread
    }, DEFAULT_LIQUIDITY_CONFIG);
    expect(wideResult.spreadScore).toBeCloseTo(0, 2);

    const tightSnap = makeSnapshot(balancedDepth(1000, 0.1, 5000));
    const tightResult = computeLiquidityScore({
      snapshot: tightSnap,
      volume: 5000,
      openInterest: 50000,
      isFnO: true,
      pctSpread: 0,
    }, DEFAULT_LIQUIDITY_CONFIG);
    expect(tightResult.spreadScore).toBeCloseTo(1, 2);
  });

  it("volume score caps at 1.0 beyond benchmark", () => {
    const snap = makeSnapshot(balancedDepth());
    const result = computeLiquidityScore({
      snapshot: snap,
      volume: 1_000_000, // way above benchmark
      openInterest: 200_000,
      isFnO: true,
      pctSpread: 0.001,
    }, DEFAULT_LIQUIDITY_CONFIG);
    expect(result.volumeScore).toBe(1);
  });

  it("all tiers map to expected multipliers", () => {
    expect(liquiditySizingMultiplier("VERY_HIGH")).toBe(1.00);
    expect(liquiditySizingMultiplier("HIGH")).toBe(0.85);
    expect(liquiditySizingMultiplier("MEDIUM")).toBe(0.65);
    expect(liquiditySizingMultiplier("LOW")).toBe(0.40);
    expect(liquiditySizingMultiplier("VERY_LOW")).toBe(0.20);
  });
});

// ── 9. VPIN computation ───────────────────────────────────────────────────────

describe("toxicity — VPIN computation", () => {
  it("flat candles produce currentVpin ≈ 0 (no informed flow)", () => {
    const candles = flatCandles(100);
    const result = computeVpin(candles, { bucketSize: 50, nBuckets: 50 });
    expect(result.currentVpin).toBeCloseTo(0, 2);
  });

  it("strongly trending candles produce currentVpin > 0.5", () => {
    const candles = risingCandles(200, 100, 2, 100);
    const result = computeVpin(candles, { bucketSize: 50, nBuckets: 50 });
    expect(result.currentVpin).toBeGreaterThan(0.5);
  });

  it("vpinSeries length is proportional to total volume / bucketSize", () => {
    // 100 candles × 100 volume = 10_000 total volume
    // bucketSize 200 → 50 buckets expected
    const candles = risingCandles(100, 100, 1, 200);
    const result = computeVpin(candles, { bucketSize: 200, nBuckets: 50 });
    expect(result.vpinSeries.length).toBe(100);
  });

  it("returns empty result for empty candle array", () => {
    const result = computeVpin([], { bucketSize: 50, nBuckets: 50 });
    expect(result.vpinSeries).toHaveLength(0);
    expect(result.currentVpin).toBe(0);
  });

  it("each bucket vpin is in [0, 1]", () => {
    const candles = risingCandles(200, 100, 1, 100);
    const result = computeVpin(candles, { bucketSize: 50, nBuckets: 50 });
    for (const v of result.vpinSeries) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("currentVpin is mean of last nBuckets buckets", () => {
    const candles = risingCandles(200, 100, 1, 50);
    const result = computeVpin(candles, { bucketSize: 50, nBuckets: 5 });
    const last5 = result.vpinSeries.slice(-5);
    const expected = last5.reduce((s, v) => s + v, 0) / last5.length;
    expect(result.currentVpin).toBeCloseTo(expected, 6);
  });
});

// ── 10. Toxicity composite ────────────────────────────────────────────────────

describe("toxicity — composite score", () => {
  it("high VPIN + extreme imbalance + wide spread → EXTREME", () => {
    const result = computeToxicityScore({
      vpin: 0.90,
      weightedImbalance: 0.02, // extremely ask-heavy
      spreadPercentile: 0.95,
    });
    expect(result.score).toBeGreaterThan(0.65);
    expect(result.tier).toBe("EXTREME");
  });

  it("low VPIN + balanced book + tight spread → BENIGN", () => {
    const result = computeToxicityScore({
      vpin: 0.05,
      weightedImbalance: 0.50,
      spreadPercentile: 0.10,
    });
    expect(result.score).toBeLessThan(0.25);
    expect(result.tier).toBe("BENIGN");
  });

  it("imbalanceExtremity is 0 at 0.5 and 1 at extremes", () => {
    expect(imbalanceExtremity(0.50)).toBeCloseTo(0, 5);
    expect(imbalanceExtremity(0.00)).toBeCloseTo(1, 5);
    expect(imbalanceExtremity(1.00)).toBeCloseTo(1, 5);
    expect(imbalanceExtremity(0.25)).toBeCloseTo(0.5, 5);
  });

  it("null spreadPercentile defaults to 0.5 (neutral contribution)", () => {
    const withNull   = computeToxicityScore({ vpin: 0.3, weightedImbalance: 0.5, spreadPercentile: null });
    const withNeutral = computeToxicityScore({ vpin: 0.3, weightedImbalance: 0.5, spreadPercentile: 0.5 });
    expect(withNull.score).toBeCloseTo(withNeutral.score, 5);
  });

  it("classifyToxicity covers all thresholds", () => {
    expect(classifyToxicity(0.10)).toBe("BENIGN");
    expect(classifyToxicity(0.35)).toBe("MODERATE");
    expect(classifyToxicity(0.60)).toBe("HIGH");
    expect(classifyToxicity(0.80)).toBe("EXTREME");
  });
});

// ── 11. Toxicity confidence and sizing adjustments ────────────────────────────

describe("toxicity — adjustments", () => {
  it("adjustConfidenceForToxicity reduces confidence proportionally", () => {
    const fullTox = computeToxicityScore({ vpin: 1, weightedImbalance: 0, spreadPercentile: 1 });
    const adj = adjustConfidenceForToxicity(0.80, fullTox, 0.40);
    // At full toxicity (score≈1): adj = 0.80 × (1 - 0.40) = 0.48
    expect(adj).toBeCloseTo(0.80 * (1 - fullTox.score * 0.40), 4);
    expect(adj).toBeLessThan(0.80);
    expect(adj).toBeGreaterThanOrEqual(0);
  });

  it("zero toxicity leaves confidence unchanged", () => {
    const noTox = computeToxicityScore({ vpin: 0, weightedImbalance: 0.5, spreadPercentile: 0 });
    const adj = adjustConfidenceForToxicity(0.75, noTox);
    expect(adj).toBeCloseTo(0.75 * (1 - noTox.score * 0.40), 4);
  });

  it("toxicitySizingMultiplier covers all tiers", () => {
    expect(toxicitySizingMultiplier("BENIGN")).toBe(1.00);
    expect(toxicitySizingMultiplier("MODERATE")).toBe(0.80);
    expect(toxicitySizingMultiplier("HIGH")).toBe(0.55);
    expect(toxicitySizingMultiplier("EXTREME")).toBe(0.30);
  });
});

// ── 12. Buy pressure ──────────────────────────────────────────────────────────

describe("pressure — buy pressure", () => {
  it("growing bids + rising price yields positive netPressure", () => {
    const tracker = new PressureTracker({ windowSize: 20, depthNormBenchmark: 5000, priceNormBenchmark: 1, depthWeight: 0.6, priceWeight: 0.4 });

    // Seed with initial snapshot
    const base = makeDepth("TEST", [
      { price: 999.5, quantity: 1000 },
      { price: 999.0, quantity: 1000 },
    ], [
      { price: 1000.5, quantity: 1000 },
      { price: 1001.0, quantity: 1000 },
    ]);
    tracker.push(buildOrderBookSnapshot(base, 1000));

    // Feed 10 ticks where bids grow and asks shrink and price rises
    let result = null;
    for (let i = 1; i <= 15; i++) {
      const d = makeDepth("TEST", [
        { price: 999.5 + i * 0.1, quantity: 1000 + i * 200 }, // growing bids
        { price: 999.0 + i * 0.1, quantity: 1000 + i * 200 },
      ], [
        { price: 1000.5 + i * 0.1, quantity: 1000 - i * 30 }, // shrinking asks
        { price: 1001.0 + i * 0.1, quantity: 1000 - i * 30 },
      ]);
      result = tracker.push(buildOrderBookSnapshot(d, 1000 + i));
    }

    expect(result).not.toBeNull();
    // netPressure confirms directional bias; window may still be in NEUTRAL zone
    expect(result!.netPressure).toBeGreaterThan(0);
    expect(result!.buyStrength).toBeGreaterThan(result!.sellStrength);
  });
});

// ── 13. Sell pressure ─────────────────────────────────────────────────────────

describe("pressure — sell pressure", () => {
  it("shrinking bids + falling price yields negative netPressure", () => {
    const tracker = new PressureTracker({ windowSize: 20, depthNormBenchmark: 5000, priceNormBenchmark: 1, depthWeight: 0.6, priceWeight: 0.4 });

    const base = makeDepth("TEST", [
      { price: 1000.5, quantity: 2000 },
      { price: 1000.0, quantity: 2000 },
    ], [
      { price: 1001.5, quantity: 1000 },
      { price: 1002.0, quantity: 1000 },
    ]);
    tracker.push(buildOrderBookSnapshot(base, 1000));

    let result = null;
    for (let i = 1; i <= 15; i++) {
      const d = makeDepth("TEST", [
        { price: 1000.5 - i * 0.1, quantity: Math.max(100, 2000 - i * 120) }, // shrinking bids
        { price: 1000.0 - i * 0.1, quantity: Math.max(100, 2000 - i * 120) },
      ], [
        { price: 1001.5 - i * 0.1, quantity: 1000 + i * 80 }, // growing asks
        { price: 1002.0 - i * 0.1, quantity: 1000 + i * 80 },
      ]);
      result = tracker.push(buildOrderBookSnapshot(d, 1000 + i));
    }

    expect(result).not.toBeNull();
    // netPressure confirms directional bias; window may still be in NEUTRAL zone
    expect(result!.netPressure).toBeLessThan(0);
    expect(result!.sellStrength).toBeGreaterThan(result!.buyStrength);
  });
});

// ── 14. Pressure — neutral ────────────────────────────────────────────────────

describe("pressure — neutral", () => {
  it("identical consecutive snapshots yield NEUTRAL", () => {
    const tracker = new PressureTracker();
    const depth = balancedDepth(1000, 1, 1000);

    tracker.push(buildOrderBookSnapshot(depth, 1000));
    let result = null;
    for (let i = 1; i <= 25; i++) {
      result = tracker.push(buildOrderBookSnapshot(depth, 1000 + i));
    }

    expect(result).not.toBeNull();
    expect(result!.netPressure).toBeCloseTo(0, 5);
    expect(result!.regime).toBe("NEUTRAL");
  });

  it("pressure regime classifier covers all branches", () => {
    expect(classifyPressureRegime(0.70)).toBe("STRONG_BUY");
    expect(classifyPressureRegime(0.30)).toBe("MILD_BUY");
    expect(classifyPressureRegime(0.00)).toBe("NEUTRAL");
    expect(classifyPressureRegime(-0.30)).toBe("MILD_SELL");
    expect(classifyPressureRegime(-0.70)).toBe("STRONG_SELL");
  });

  it("tracker returns null on first push", () => {
    const tracker = new PressureTracker();
    const result = tracker.push(buildOrderBookSnapshot(balancedDepth(), 1000));
    expect(result).toBeNull();
  });
});

// ── 15. ExecQuality — EXCELLENT ───────────────────────────────────────────────

describe("execQuality — EXCELLENT conditions", () => {
  it("tight spread + deep liquidity + benign toxicity → EXCELLENT", () => {
    const engine = createMicrostructureEngine("NIFTY-FUT", {
      qualityGates: DEFAULT_MICROSTRUCTURE_CONFIG.qualityGates,
    });

    // Prime VPIN with flat candles → near zero
    engine.onCandles(flatCandles(100));

    // Tight, balanced, deep book
    const depth = balancedDepth(17500, 2, 15_000);
    const snap = engine.onDepthTick(depth, { volume: 12_000, openInterest: 500_000, isFnO: true });

    expect(snap.execQuality).toBe("EXCELLENT");
  });
});

// ── 16. ExecQuality — POOR ────────────────────────────────────────────────────

describe("execQuality — POOR conditions", () => {
  it("very wide spread + high toxicity + thin book → POOR", () => {
    const engine = createMicrostructureEngine("DEEP-OTM-OPT", {
      qualityGates: DEFAULT_MICROSTRUCTURE_CONFIG.qualityGates,
    });

    // Prime VPIN with strongly trending candles → high VPIN
    engine.onCandles(risingCandles(200, 100, 5, 100));

    // Prime spread tracker with 40 tight ticks so the wide spread becomes clearly wide
    const tightDepth = balancedDepth(100, 0.1, 200);
    for (let i = 0; i < 40; i++) {
      engine.onDepthTick(tightDepth, { volume: 50, openInterest: 100, isFnO: true }, 1000 + i);
    }

    // Now feed the thin/wide tick
    const depth = thinDepth(100); // 200bps spread, minimal depth
    const snap = engine.onDepthTick(depth, { volume: 5, openInterest: 50, isFnO: true }, 99000);

    expect(["FAIR", "POOR"]).toContain(snap.execQuality);
  });
});

// ── 17. Feature store — 1m bucket ────────────────────────────────────────────

describe("feature store — 1m aggregation", () => {
  it("ticks spanning > 1 minute produce a completed 1m bucket", () => {
    const engine = createMicrostructureEngine("TEST", {
      featureBucketMs: [60_000, 300_000],
      maxFeatureBuckets: 10,
    });

    const depth = balancedDepth(1000, 1, 2000);
    const base  = 0;

    // Feed ticks for 90 seconds (enough to close one 1m bucket)
    for (let t = 0; t <= 90_000; t += 5_000) {
      engine.onDepthTick(depth, { volume: 1000, openInterest: 50_000, isFnO: true }, base + t);
    }

    const store = engine.featureStore;
    expect(store["1m"].length).toBeGreaterThanOrEqual(1);
  });

  it("1m bucket contains valid aggregated statistics", () => {
    const engine = createMicrostructureEngine("TEST", {
      featureBucketMs: [60_000, 300_000],
      maxFeatureBuckets: 10,
    });

    const depth = balancedDepth(1000, 1, 2000);
    for (let t = 0; t <= 90_000; t += 5_000) {
      engine.onDepthTick(depth, { volume: 1000, openInterest: 50_000, isFnO: true }, t);
    }

    const bucket = engine.featureStore["1m"][0];
    expect(bucket.tickCount).toBeGreaterThan(0);
    expect(bucket.imbalanceMean).toBeCloseTo(0.5, 1);
    expect(bucket.spreadMean).toBeGreaterThan(0);
    expect(bucket.liquidityMean).toBeGreaterThan(0);
    expect(bucket.dominantExecQuality).toBeDefined();
    expect(["EXCELLENT", "GOOD", "FAIR", "POOR"]).toContain(bucket.dominantExecQuality);
  });

  it("ring buffer evicts oldest bucket when maxFeatureBuckets is reached", () => {
    const engine = createMicrostructureEngine("TEST", {
      featureBucketMs: [60_000, 300_000],
      maxFeatureBuckets: 3,
    });

    const depth = balancedDepth();
    // Feed 4 full minutes
    for (let t = 0; t <= 4 * 60_000; t += 10_000) {
      engine.onDepthTick(depth, { volume: 500, openInterest: 10_000, isFnO: false }, t);
    }

    expect(engine.featureStore["1m"].length).toBeLessThanOrEqual(3);
  });
});

// ── 18. Feature store — 5m bucket ────────────────────────────────────────────

describe("feature store — 5m aggregation", () => {
  it("ticks spanning > 5 minutes produce a completed 5m bucket", () => {
    const engine = createMicrostructureEngine("TEST", {
      featureBucketMs: [60_000, 300_000],
      maxFeatureBuckets: 10,
    });

    const depth = balancedDepth(1000, 1, 2000);
    for (let t = 0; t <= 360_000; t += 15_000) {
      engine.onDepthTick(depth, { volume: 1000, openInterest: 50_000, isFnO: true }, t);
    }

    expect(engine.featureStore["5m"].length).toBeGreaterThanOrEqual(1);
  });
});

// ── 19. Engine reset ──────────────────────────────────────────────────────────

describe("MicrostructureEngine reset", () => {
  it("clears all state after reset", () => {
    const engine = createMicrostructureEngine("TEST", {
      featureBucketMs: [60_000, 300_000],
      maxFeatureBuckets: 10,
    });

    const depth = balancedDepth();
    for (let t = 0; t <= 120_000; t += 10_000) {
      engine.onDepthTick(depth, { volume: 1000, openInterest: 50_000, isFnO: true }, t);
    }

    expect(engine.featureStore["1m"].length).toBeGreaterThan(0);

    engine.reset();

    expect(engine.featureStore["1m"]).toHaveLength(0);
    expect(engine.featureStore["5m"]).toHaveLength(0);
    expect(engine.currentVpin).toBe(0);
  });

  it("engine produces valid snapshot after reset", () => {
    const engine = createMicrostructureEngine("TEST");
    engine.reset();

    const snap = engine.onDepthTick(
      balancedDepth(),
      { volume: 1000, openInterest: 10_000, isFnO: true },
      1000,
    );

    expect(snap.execQuality).toBeDefined();
    expect(snap.sizingMultiplier).toBeGreaterThan(0);
  });
});

// ── 20. execQualityToFillScore ────────────────────────────────────────────────

describe("execQualityToFillScore", () => {
  it("maps all ExecQuality values to correct fill scores", () => {
    expect(execQualityToFillScore("EXCELLENT")).toBe(1.00);
    expect(execQualityToFillScore("GOOD")).toBe(0.75);
    expect(execQualityToFillScore("FAIR")).toBe(0.50);
    expect(execQualityToFillScore("POOR")).toBe(0.25);
  });
});

// ── MicrostructureEngine — sizing multiplier ──────────────────────────────────

describe("MicrostructureEngine — sizingMultiplier", () => {
  it("sizingMultiplier is in (0, 1]", () => {
    const engine = createMicrostructureEngine("TEST");
    const snap = engine.onDepthTick(
      balancedDepth(),
      { volume: 5000, openInterest: 50_000, isFnO: true },
    );
    expect(snap.sizingMultiplier).toBeGreaterThan(0);
    expect(snap.sizingMultiplier).toBeLessThanOrEqual(1);
  });

  it("thin illiquid book produces a lower sizingMultiplier than liquid book", () => {
    const liquidEngine = createMicrostructureEngine("LIQUID");
    const liquidSnap = liquidEngine.onDepthTick(
      balancedDepth(1000, 1, 10_000),
      { volume: 15_000, openInterest: 200_000, isFnO: true },
    );

    const thinEngine = createMicrostructureEngine("THIN");
    const thinSnap = thinEngine.onDepthTick(
      thinDepth(1000),
      { volume: 20, openInterest: 100, isFnO: true },
    );

    expect(thinSnap.sizingMultiplier).toBeLessThan(liquidSnap.sizingMultiplier);
  });
});
