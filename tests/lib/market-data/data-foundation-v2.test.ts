/**
 * Data Foundation V2 — regression + unit tests for the new data-integrity
 * infrastructure and the V1 fixes that must stay fixed (Phase 63/64).
 *
 * All tests here are PURE (no DB / no network) so they are deterministic.
 */
import { describe, it, expect } from "vitest";

import {
  buildAvailability,
  worstStatus,
  isTradableStatus,
  NON_TRADABLE_STATUSES,
  DATASET_VERSION,
  newRequestId,
} from "@/lib/market-data/data-availability";
import {
  evaluateSnapshotConsistency,
  evaluateGlobalDataState,
  strategyMayOperate,
  DEFAULT_MAX_SNAPSHOT_SKEW_MS,
} from "@/lib/market-data/data-gate";
import { failureKindToStatus, errorToStatus } from "@/lib/market-data/services/read-with-status.service";
import { filterValidCandlesWithReport, filterValidCandles } from "@/lib/market-data/validation/candle-validator";
import { expectedBars, tradingDaysInRange } from "@/lib/market-data/services/coverage.service";
import { MarketDataError } from "@/lib/market-data/types";
import type { OHLCVCandle } from "@/lib/market-data/types";

// ── DataAvailability contract ──────────────────────────────────────────────

describe("DataAvailability contract", () => {
  it("computes staleAge from dataTimestamp vs receivedAt", () => {
    const a = buildAvailability<number[]>({
      data: [1, 2, 3],
      status: "AVAILABLE",
      dataTimestamp: "2026-09-10T10:00:00.000Z",
      receivedAt: "2026-09-10T10:00:05.000Z",
    });
    expect(a.staleAge).toBe(5000);
    expect(a.datasetVersion).toBe(DATASET_VERSION);
    expect(a.requestId).toMatch(/^md_/);
  });

  it("worstStatus picks the more-severe status", () => {
    expect(worstStatus("AVAILABLE", "PROVIDER_FAILED")).toBe("PROVIDER_FAILED");
    expect(worstStatus("STALE", "PARTIAL")).toBe("STALE");
    expect(worstStatus("AVAILABLE", "PARTIAL")).toBe("PARTIAL");
  });

  it("hard vetoes are not tradable; AVAILABLE/PARTIAL/STALE are", () => {
    for (const s of NON_TRADABLE_STATUSES) expect(isTradableStatus(s)).toBe(false);
    expect(isTradableStatus("AVAILABLE")).toBe(true);
    expect(isTradableStatus("PARTIAL")).toBe(true);
    expect(isTradableStatus("STALE")).toBe(true);
  });

  it("newRequestId is unique across calls", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

// ── Error → status mapping (Phase 4 / G-13) ────────────────────────────────

describe("error → DataAvailabilityStatus mapping", () => {
  it("maps failure kinds to the right status", () => {
    expect(failureKindToStatus("auth_failure")).toBe("AUTH_FAILED");
    expect(failureKindToStatus("hard_block")).toBe("AUTH_FAILED");
    expect(failureKindToStatus("rate_limit")).toBe("RATE_LIMITED");
    expect(failureKindToStatus("malformed")).toBe("INVALID");
    expect(failureKindToStatus("unavailable")).toBe("PROVIDER_FAILED");
    expect(failureKindToStatus("timeout")).toBe("PROVIDER_FAILED");
    expect(failureKindToStatus("network")).toBe("PROVIDER_FAILED");
  });

  it("classifies a typed MarketDataError by http status", () => {
    expect(errorToStatus(new MarketDataError("x", "upstox", undefined, 429))).toBe("RATE_LIMITED");
    expect(errorToStatus(new MarketDataError("x", "upstox", undefined, 403))).toBe("AUTH_FAILED");
    expect(errorToStatus(new MarketDataError("x", "upstox", undefined, 503))).toBe("PROVIDER_FAILED");
  });
});

// ── Snapshot consistency gate (Phase 40) ───────────────────────────────────

describe("snapshot consistency gate", () => {
  const t0 = Date.parse("2026-09-10T10:00:00.000Z");

  it("passes when critical fields are within tolerance", () => {
    const r = evaluateSnapshotConsistency([
      { name: "stockLtp", timestampMs: t0, critical: true },
      { name: "niftyClose", timestampMs: t0 + 10_000, critical: true },
    ]);
    expect(r.consistent).toBe(true);
    expect(r.status).toBe("AVAILABLE");
  });

  it("vetoes when critical-field skew exceeds tolerance", () => {
    const r = evaluateSnapshotConsistency([
      { name: "stockLtp", timestampMs: t0, critical: true },
      { name: "oi", timestampMs: t0 - (DEFAULT_MAX_SNAPSHOT_SKEW_MS + 5_000), critical: true },
    ]);
    expect(r.consistent).toBe(false);
    expect(r.status).toBe("DATA_SNAPSHOT_INCONSISTENT");
    expect(r.oldestField).toBe("oi");
  });

  it("ignores optional fields when computing skew", () => {
    const r = evaluateSnapshotConsistency([
      { name: "stockLtp", timestampMs: t0, critical: true },
      { name: "news", timestampMs: t0 - 3_600_000, critical: false },
    ]);
    expect(r.consistent).toBe(true);
  });
});

// ── Global data state (Phase 65/66) ────────────────────────────────────────

describe("global data state", () => {
  it("DATA_BLOCKED when a critical dep is non-tradable", () => {
    const d = evaluateGlobalDataState([
      { name: "ohlcv", status: "AVAILABLE", critical: true },
      { name: "oi", status: "PROVIDER_FAILED", critical: true },
    ]);
    expect(d.state).toBe("DATA_BLOCKED");
    expect(d.tradable).toBe(false);
    expect(d.blockedBy).toContain("oi:PROVIDER_FAILED");
  });

  it("DATA_DEGRADED when only optional/soft issues exist", () => {
    const d = evaluateGlobalDataState([
      { name: "ohlcv", status: "AVAILABLE", critical: true },
      { name: "news", status: "UNAVAILABLE", critical: false },
      { name: "depth", status: "STALE", critical: false },
    ]);
    expect(d.state).toBe("DATA_DEGRADED");
    expect(d.tradable).toBe(false);
  });

  it("DATA_READY when all deps healthy", () => {
    const d = evaluateGlobalDataState([
      { name: "ohlcv", status: "AVAILABLE", critical: true },
      { name: "nifty", status: "AVAILABLE", critical: true },
    ]);
    expect(d.state).toBe("DATA_READY");
    expect(d.tradable).toBe(true);
  });

  it("strategyMayOperate allows a strategy whose own critical deps are healthy", () => {
    const ok = strategyMayOperate([{ name: "ohlcv", status: "AVAILABLE", critical: true }]);
    expect(ok.allowed).toBe(true);
    const blocked = strategyMayOperate([{ name: "oi", status: "STALE", critical: true }]);
    // STALE is a hard veto only if in NON_TRADABLE; STALE is NOT — so allowed.
    expect(blocked.allowed).toBe(true);
    const hard = strategyMayOperate([{ name: "oi", status: "PROVIDER_FAILED", critical: true }]);
    expect(hard.allowed).toBe(false);
  });
});

// ── Candle drop reporting (RCA-D04 regression) ─────────────────────────────

describe("filterValidCandlesWithReport (no silent drops)", () => {
  const good: OHLCVCandle = { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 5 };
  const badHighLow: OHLCVCandle = { time: 200, open: 10, high: 8, low: 9, close: 9, volume: 1 };
  const outOfOrder: OHLCVCandle = { time: 50, open: 10, high: 12, low: 9, close: 11, volume: 1 };

  it("reports dropped invalid + out-of-order candles", () => {
    const r = filterValidCandlesWithReport([good, badHighLow, outOfOrder]);
    expect(r.candles).toHaveLength(1);
    expect(r.droppedCount).toBe(2);
    expect(r.dropped.some((d) => d.error === "HIGH_BELOW_LOW")).toBe(true);
    expect(r.dropped.some((d) => d.error === "TIMESTAMP_NOT_ASCENDING")).toBe(true);
  });

  it("filterValidCandles stays behaviour-compatible", () => {
    const legacy = filterValidCandles([good, badHighLow, outOfOrder]);
    const report = filterValidCandlesWithReport([good, badHighLow, outOfOrder]);
    expect(legacy).toEqual(report.candles);
  });
});

// ── Coverage engine pure functions (Phase 10) ──────────────────────────────

describe("coverage engine (calendar-aware)", () => {
  it("counts trading days excluding weekends", () => {
    // Mon 2026-09-07 .. Fri 2026-09-11 (5 weekdays; assume no holiday in window)
    const from = Date.parse("2026-09-07T00:00:00.000Z");
    const to = Date.parse("2026-09-11T23:59:00.000Z");
    const td = tradingDaysInRange(from, to);
    expect(td).toBeGreaterThanOrEqual(4);
    expect(td).toBeLessThanOrEqual(5);
  });

  it("expectedBars scales daily by trading days", () => {
    const from = Date.parse("2026-09-07T00:00:00.000Z");
    const to = Date.parse("2026-09-11T23:59:00.000Z");
    const daily = expectedBars("1d", from, to);
    const fiveMin = expectedBars("5m", from, to);
    expect(fiveMin).toBeGreaterThan(daily);
  });

  it("returns 0 for an inverted range", () => {
    expect(tradingDaysInRange(2000, 1000)).toBe(0);
  });
});
