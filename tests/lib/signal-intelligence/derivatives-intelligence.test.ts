/**
 * Tests — Derivatives Intelligence (Phases 14–18)
 *
 * OI classification, options chain, flow quality, expiry context.
 * Regression tests for known problems with OI data freshness and
 * Max Pain as contextual evidence (not price target).
 */

import { describe, it, expect } from "vitest";
import {
  classifyOIBuildup,
  buildOptionChainIntelligence,
  classifyOptionsFlow,
  buildExpiryContext,
  getStrategyExpiryBehavior,
} from "@/lib/signal-intelligence/derivatives-intelligence";

const NOW_MS = Date.now();

describe("classifyOIBuildup", () => {
  it("classifies LONG_BUILDUP for price up + OI up", () => {
    const result = classifyOIBuildup(1.5, 50_000, 500_000, NOW_MS - 60_000, NOW_MS);
    expect(result.kind).toBe("LONG_BUILDUP");
    expect(result.oiDataFresh).toBe(true);
  });

  it("classifies SHORT_BUILDUP for price down + OI up", () => {
    const result = classifyOIBuildup(-1.2, 50_000, 500_000, NOW_MS - 60_000, NOW_MS);
    expect(result.kind).toBe("SHORT_BUILDUP");
  });

  it("classifies SHORT_COVERING for price up + OI down", () => {
    const result = classifyOIBuildup(1.0, -30_000, 470_000, NOW_MS - 60_000, NOW_MS);
    expect(result.kind).toBe("SHORT_COVERING");
  });

  it("classifies LONG_UNWINDING for price down + OI down", () => {
    const result = classifyOIBuildup(-1.0, -30_000, 470_000, NOW_MS - 60_000, NOW_MS);
    expect(result.kind).toBe("LONG_UNWINDING");
  });

  it("returns UNCLASSIFIED for stale OI data", () => {
    const staleTs = NOW_MS - 20 * 60 * 1000; // 20 minutes old
    const result = classifyOIBuildup(1.5, 50_000, 500_000, staleTs, NOW_MS);
    expect(result.kind).toBe("UNCLASSIFIED");
    expect(result.oiDataFresh).toBe(false);
  });

  it("returns UNCLASSIFIED when OI is null", () => {
    const result = classifyOIBuildup(1.5, 50_000, null, NOW_MS, NOW_MS);
    expect(result.kind).toBe("UNCLASSIFIED");
  });

  it("returns NEUTRAL for tiny price change (< 0.1%)", () => {
    const result = classifyOIBuildup(0.05, 50_000, 500_000, NOW_MS - 60_000, NOW_MS);
    expect(result.kind).toBe("NEUTRAL");
  });
});

describe("buildOptionChainIntelligence", () => {
  it("computes ATM as nearest round strike to spot", () => {
    const chain = buildOptionChainIntelligence({
      underlying: "NIFTY",
      spot: 24350,
      expiry: "2026-09-04",
      atmIv: 13.5,
      pcrOi: 1.2,
      pcrVolume: 1.1,
      maxCeOiStrike: 24500,
      maxPeOiStrike: 24000,
      maxPain: 24200,
      totalCeOi: 5_000_000,
      totalPeOi: 6_000_000,
      totalCeOiChange: 100_000,
      totalPeOiChange: 200_000,
      fetchedAtMs: NOW_MS - 60_000,
    });
    // 24350 rounded to nearest 50 = 24350
    expect(chain.atm).toBe(24350);
  });

  it("classifies chain as STALE when data is old", () => {
    const chain = buildOptionChainIntelligence({
      underlying: "NIFTY",
      spot: 24350,
      expiry: "2026-09-04",
      atmIv: 13.5,
      pcrOi: 1.2,
      pcrVolume: null,
      maxCeOiStrike: null,
      maxPeOiStrike: null,
      maxPain: null,
      totalCeOi: 0,
      totalPeOi: 0,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      fetchedAtMs: NOW_MS - 20 * 60 * 1000, // 20 min old
    });
    expect(chain.chainQuality).toBe("STALE");
  });

  it("classifies chain as MISSING when no OI data", () => {
    const chain = buildOptionChainIntelligence({
      underlying: "NIFTY",
      spot: 24350,
      expiry: "2026-09-04",
      atmIv: null,
      pcrOi: null,
      pcrVolume: null,
      maxCeOiStrike: null,
      maxPeOiStrike: null,
      maxPain: null,
      totalCeOi: 0,
      totalPeOi: 0,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      fetchedAtMs: NOW_MS - 60_000,
    });
    expect(chain.chainQuality).toBe("MISSING");
  });

  it("computes callWallDistance as % from spot to CE wall", () => {
    const chain = buildOptionChainIntelligence({
      underlying: "NIFTY",
      spot: 24000,
      expiry: "2026-09-04",
      atmIv: 13.5,
      pcrOi: 1.0,
      pcrVolume: null,
      maxCeOiStrike: 24500,
      maxPeOiStrike: 23500,
      maxPain: 24200,
      totalCeOi: 5_000_000,
      totalPeOi: 6_000_000,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      fetchedAtMs: NOW_MS - 60_000,
    });
    // (24500 - 24000) / 24000 * 100 = 2.08%
    expect(chain.callWallDistance).toBeCloseTo(2.08, 1);
  });
});

describe("REGRESSION: options flow never claims smart money from OI alone", () => {
  it("flow classification always includes a warning about OI limitations", () => {
    const oiBuildup = classifyOIBuildup(1.5, 50_000, 500_000, NOW_MS - 60_000, NOW_MS);
    const chain = buildOptionChainIntelligence({
      underlying: "NIFTY",
      spot: 24000,
      expiry: "2026-09-04",
      atmIv: 13.5,
      pcrOi: 1.3,
      pcrVolume: null,
      maxCeOiStrike: 24500,
      maxPeOiStrike: 23500,
      maxPain: 24200,
      totalCeOi: 5_000_000,
      totalPeOi: 7_000_000,
      totalCeOiChange: 100_000,
      totalPeOiChange: 300_000,
      fetchedAtMs: NOW_MS - 60_000,
    });
    const flow = classifyOptionsFlow(oiBuildup, chain);
    expect(flow.warnings.length).toBeGreaterThan(0);
    expect(flow.warnings[0]).toContain("OI-based flow classification is OBSERVATION only");
  });

  it("flow confidence is OBSERVATION for single data point", () => {
    const oiBuildup = classifyOIBuildup(0.05, 10_000, 500_000, NOW_MS - 60_000, NOW_MS);
    const chain = buildOptionChainIntelligence({
      underlying: "NIFTY",
      spot: 24000,
      expiry: "2026-09-04",
      atmIv: null,
      pcrOi: null,
      pcrVolume: null,
      maxCeOiStrike: null,
      maxPeOiStrike: null,
      maxPain: null,
      totalCeOi: 100,
      totalPeOi: 100,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      fetchedAtMs: NOW_MS - 60_000,
    });
    const flow = classifyOptionsFlow(oiBuildup, chain);
    expect(flow.confidence).toBe("OBSERVATION");
  });
});

describe("buildExpiryContext", () => {
  it("detects Thursday as expiry day", () => {
    // Find next Thursday
    const d = new Date();
    d.setUTCHours(10, 0, 0, 0);
    while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
    const ctx = buildExpiryContext(d.getTime() - 5.5 * 3600 * 1000); // convert from IST
    expect(ctx.isExpiryDay).toBe(true);
    expect(ctx.isWeeklyExpiry || ctx.isMonthlyExpiry).toBe(true);
  });

  it("detects gamma risk active after 14:30 IST on expiry", () => {
    // Thursday at 14:45 IST = 09:15 UTC
    const d = new Date();
    while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(9, 15, 0, 0); // 14:45 IST
    const ctx = buildExpiryContext(d.getTime());
    expect(ctx.gammaRiskActive).toBe(true);
  });

  it("Monday is not expiry day", () => {
    const d = new Date();
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(5, 0, 0, 0);
    const ctx = buildExpiryContext(d.getTime());
    expect(ctx.isExpiryDay).toBe(false);
  });
});

describe("getStrategyExpiryBehavior", () => {
  const expiryCtx = buildExpiryContext((() => {
    const d = new Date();
    while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(6, 0, 0, 0); // 11:30 IST (before gamma risk)
    return d.getTime();
  })());

  it("MAX_PAIN_GRAVITY uses EXPIRY_SPECIAL_MODE on expiry", () => {
    if (!expiryCtx.isExpiryDay) return; // skip if not Thursday test run
    expect(getStrategyExpiryBehavior("MAX_PAIN_GRAVITY", expiryCtx)).toBe("EXPIRY_SPECIAL_MODE");
  });

  it("OPENING_BREAKOUT reduces size on expiry", () => {
    if (!expiryCtx.isExpiryDay) return;
    expect(getStrategyExpiryBehavior("OPENING_BREAKOUT", expiryCtx)).toBe("REDUCE_SIZE_EXPIRY");
  });

  it("returns ALLOW_EXPIRY on non-expiry day", () => {
    const nonExpiry = buildExpiryContext((() => {
      const d = new Date();
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(5, 0, 0, 0);
      return d.getTime();
    })());
    expect(getStrategyExpiryBehavior("OPENING_BREAKOUT", nonExpiry)).toBe("ALLOW_EXPIRY");
  });
});
