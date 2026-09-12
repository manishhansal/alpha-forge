/**
 * Data Foundation V7 — unit + fault-injection tests for the V7 additions.
 *
 * Covered (real code, no fabrication):
 *   §3   instrument-master universe: checksum determinism + counts + classification.
 *   §4   feature-lookback: required bars/sessions monotonic + grounded.
 *   §5   capability matrix fixes (Angel no-3m, index routing) + backfill runner
 *        fault injection (401/429/timeout/empty/malformed → fallback/breaker).
 *   §9-12 option strike normalization: NULL fields → *Unavailable flags, never 0.
 *   §16  realtime-vs-historical reconciliation tolerance + mismatch recording.
 *
 * DB EFFECTS (real acquisition, gap recovery, option capture, universe persist)
 * are proven by the DB-verified counts in ALPHAFORGE_DATA_V7_FINAL_REPORT.md
 * and the scripts/data-cli.ts + data-v7-gaps.ts harnesses.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  historyProvidersFor,
  historyProvidersForSymbol,
  isIndexSymbol,
  intervalCapability,
  PROVIDER_CAPABILITY_MATRIX,
} from "@/lib/market-data/provider-capability-matrix";
import {
  computeTimeframeRequirements,
  requiredBarsForTimeframe,
  requiredSessionsForTimeframe,
  calendarDaysForTimeframe,
} from "@/lib/market-data/services/feature-lookback.service";
import {
  computeUniverseChecksum,
  computeUniverseCounts,
  type UniverseEntry,
} from "@/lib/market-data/services/instrument-master-universe.service";
import { chainToStrikes } from "@/lib/market-data/services/option-strike-capture.service";
import {
  makeCapabilityAwareFetcher,
  _resetBackfillBreakers,
  type ProviderFetchers,
} from "@/lib/market-data/services/fno-backfill-runner.service";
import { LIVE_INTERVALS } from "@/lib/market-data/services/candle-builder.service";
import { SUPPORTED_TIMEFRAMES, isSupportedInterval, assertSupportedInterval } from "@/lib/market-data/types";

// ── V8 3m removal audit ───────────────────────────────────────────────────────

describe("V8 — 3m permanently removed from AlphaForge", () => {
  it("LIVE_INTERVALS does not contain 3m", () => {
    // 3m has been removed from the candle builder and all production code.
    expect(LIVE_INTERVALS).not.toContain("3m");
    expect(LIVE_INTERVALS).toContain("1m");
    expect(LIVE_INTERVALS).toContain("5m");
  });

  it("SUPPORTED_TIMEFRAMES from types does not contain 3m", () => {
    expect(SUPPORTED_TIMEFRAMES).not.toContain("3m");
    expect(SUPPORTED_TIMEFRAMES).toContain("1m");
    expect(SUPPORTED_TIMEFRAMES).toContain("5m");
    expect(SUPPORTED_TIMEFRAMES).toContain("10m");
    expect(SUPPORTED_TIMEFRAMES).toContain("1w");
    expect(SUPPORTED_TIMEFRAMES).toContain("1M");
    expect(SUPPORTED_TIMEFRAMES).toHaveLength(9); // exactly the 9 supported ones
  });

  it("isSupportedInterval rejects 3m with false", () => {
    expect(isSupportedInterval("3m")).toBe(false);
    expect(isSupportedInterval("5m")).toBe(true);
    expect(isSupportedInterval("1m")).toBe(true);
  });

  it("assertSupportedInterval throws for 3m", () => {
    expect(() => assertSupportedInterval("3m")).toThrow(/3m.*removed/i);
    expect(() => assertSupportedInterval("5m")).not.toThrow();
  });

  it("capability matrix has no 3m entry for any provider", () => {
    for (const row of PROVIDER_CAPABILITY_MATRIX) {
      expect(Object.keys(row.intervals)).not.toContain("3m");
    }
  });

  it("indices route history away from Angel (Angel returns empty for index tokens)", () => {
    expect(isIndexSymbol("NIFTY")).toBe(true);
    expect(isIndexSymbol("RELIANCE")).toBe(false);
    const idx = historyProvidersForSymbol("NIFTY", "5m");
    expect(idx).not.toContain("angel_one");
    const eq = historyProvidersForSymbol("RELIANCE", "5m");
    expect(eq).toContain("angel_one");
  });

  it("Upstox minute intervals use small per-request windows (avoid HTTP 400)", () => {
    expect(intervalCapability("upstox", "1m").maxChunkDays).toBeLessThanOrEqual(7);
    // 3m is no longer in scope — upstox has no "3m" entry.
  });

  it("jugaad and openchart are registered in the capability matrix", () => {
    const jugaad = intervalCapability("jugaad", "1d");
    const openchart5m = intervalCapability("openchart", "5m");
    expect(jugaad.supported).toBe(true);
    expect(jugaad.history).toBe(true);
    expect(openchart5m.supported).toBe(true);
    expect(openchart5m.history).toBe(true);
    expect(openchart5m.live).toBe(false); // openchart has no live data
  });
});

// ── §4 feature-lookback ──────────────────────────────────────────────────────

describe("V7 §4 — feature lookback requirements", () => {
  it("requiredBars are positive and buffer-inclusive per timeframe", () => {
    const reqs = computeTimeframeRequirements();
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) {
      expect(r.requiredBars).toBeGreaterThan(0);
      expect(r.requiredBarsWithBuffer).toBeGreaterThanOrEqual(r.requiredBars);
      expect(r.requiredSessions).toBeGreaterThanOrEqual(1);
    }
  });

  it("EMA200 drives the deepest daily/5m requirement (>= 600 bars settled)", () => {
    // EMA200 settled at 3x = 600 bars.
    expect(requiredBarsForTimeframe("1d")).toBeGreaterThanOrEqual(600);
    expect(requiredBarsForTimeframe("5m")).toBeGreaterThanOrEqual(600);
  });

  it("calendar days exceed sessions (weekend/holiday headroom)", () => {
    const sessions = requiredSessionsForTimeframe("1d");
    const days = calendarDaysForTimeframe("1d");
    expect(days).toBeGreaterThan(sessions);
  });
});

// ── §3 universe checksum + counts ────────────────────────────────────────────

function mkEntry(p: Partial<UniverseEntry>): UniverseEntry {
  return {
    provider: "angel_one", instrumentKey: null, symbol: "X", exchange: "NSE",
    segment: "NFO", instrumentType: "OPTIDX", isin: null, symbolToken: "1",
    expiry: null, strike: null, optionType: null, lotSize: null, tickSize: null,
    underlying: "NIFTY", active: true, ...p,
  };
}

describe("V7 §3 — instrument-master universe", () => {
  it("checksum is deterministic and order-independent", () => {
    const a = [mkEntry({ symbol: "A" }), mkEntry({ symbol: "B" })];
    const b = [mkEntry({ symbol: "B" }), mkEntry({ symbol: "A" })];
    expect(computeUniverseChecksum(a)).toBe(computeUniverseChecksum(b));
  });

  it("checksum changes when the universe changes", () => {
    const a = [mkEntry({ symbol: "A" })];
    const b = [mkEntry({ symbol: "A" }), mkEntry({ symbol: "C" })];
    expect(computeUniverseChecksum(a)).not.toBe(computeUniverseChecksum(b));
  });

  it("counts classify options/futures/equities/indices distinctly", () => {
    const entries = [
      mkEntry({ instrumentType: "OPTIDX", underlying: "NIFTY" }),
      mkEntry({ instrumentType: "OPTSTK", underlying: "RELIANCE" }),
      mkEntry({ instrumentType: "FUTIDX", underlying: "NIFTY" }),
      mkEntry({ instrumentType: "EQ", underlying: "RELIANCE" }),
      mkEntry({ instrumentType: "INDEX", underlying: "NIFTY" }),
    ];
    const c = computeUniverseCounts(entries);
    expect(c.fnoOptionCount).toBe(2);
    expect(c.fnoFutureCount).toBe(1);
    expect(c.fnoEquityCount).toBe(1);
    expect(c.fnoIndexCount).toBe(1);
    expect(c.fnoUniverseCount).toBe(2); // NIFTY + RELIANCE underlyings across F&O
  });
});

// ── §9-12 option strike normalization ────────────────────────────────────────

describe("V7 §9-12 — option strike normalization never fabricates", () => {
  it("maps missing IV/bid/ask to null (caller flags *Unavailable), keeps real OI", () => {
    const chain = {
      symbol: "NIFTY",
      expiry: "29-Sep-2026",
      rows: [
        { strike: 24000, ce: { strike: 24000, type: "CE" as const, oi: 1234, iv: null, ltp: 50, bid: null, ask: null, volume: 10 }, pe: null },
      ],
    };
    const strikes = chainToStrikes(chain, "angel_one");
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.oi).toBe(1234); // real OI preserved
    expect(strikes[0]!.iv).toBeNull(); // NOT 0
    expect(strikes[0]!.bid).toBeNull();
    expect(strikes[0]!.ask).toBeNull();
  });

  it("drops non-finite provider values to null (never NaN/Infinity)", () => {
    const chain = {
      symbol: "NIFTY", expiry: "29-Sep-2026",
      rows: [{ strike: 1, ce: { strike: 1, type: "CE" as const, oi: Number.NaN, iv: Infinity, ltp: 5 }, pe: null }],
    };
    const s = chainToStrikes(chain, "angel_one")[0]!;
    expect(s.oi).toBeNull();
    expect(s.iv).toBeNull();
    expect(s.ltp).toBe(5);
  });
});

// ── §5/§18 backfill runner fault injection ───────────────────────────────────

describe("V7 §18 — backfill fetcher fault injection + circuit breaker", () => {
  beforeEach(() => _resetBackfillBreakers());

  const chunkArgs = {
    instrumentId: "RELIANCE", exchange: "NSE", interval: "5m" as const,
    fromIstDate: "2026-09-01", toIstDate: "2026-09-08", provider: "angel_one" as const,
  };

  function fetchersThatThrow(msg: string): ProviderFetchers {
    return {
      angelGetHistorical: async () => { throw new Error(msg); },
      upstoxGetHistoricalV3: async () => { throw new Error(msg); },
    };
  }

  it("classifies a 429 as RATE_LIMITED", async () => {
    const fetcher = makeCapabilityAwareFetcher(fetchersThatThrow("HTTP 429 Too Many Requests"));
    const res = await fetcher(chunkArgs);
    expect(res.outcome).toBe("RATE_LIMITED");
    expect(res.candles).toHaveLength(0);
  });

  it("classifies a 401 as AUTH_FAILED", async () => {
    const fetcher = makeCapabilityAwareFetcher(fetchersThatThrow("HTTP 401 auth error"));
    const res = await fetcher(chunkArgs);
    expect(res.outcome).toBe("AUTH_FAILED");
  });

  it("classifies a timeout as TIMEOUT", async () => {
    const fetcher = makeCapabilityAwareFetcher(fetchersThatThrow("operation timeout"));
    const res = await fetcher(chunkArgs);
    expect(res.outcome).toBe("TIMEOUT");
  });

  it("treats an empty provider response as EMPTY (never fabricates bars)", async () => {
    const fetcher = makeCapabilityAwareFetcher({
      angelGetHistorical: async () => [],
      upstoxGetHistoricalV3: async () => [],
    });
    const res = await fetcher(chunkArgs);
    expect(res.outcome).toBe("EMPTY");
    expect(res.candles).toHaveLength(0);
  });

  it("opens the circuit after repeated failures (fast-fails subsequent calls)", async () => {
    const fetcher = makeCapabilityAwareFetcher(fetchersThatThrow("HTTP 500 boom"));
    // 5 failures trip the breaker (threshold=5). Each failing call also runs the
    // real exponential-backoff retries, so allow a generous timeout — this test
    // exercises the ACTUAL retry+breaker timing, not a mocked clock.
    for (let i = 0; i < 5; i++) await fetcher(chunkArgs);
    const res = await fetcher(chunkArgs);
    expect(res.errorClass).toBe("circuit_open");
  }, 30_000);

  it("routes an index chunk away from Angel even if Angel is the passed provider", async () => {
    let angelCalled = false;
    let upstoxCalled = false;
    const fetcher = makeCapabilityAwareFetcher({
      angelGetHistorical: async () => { angelCalled = true; return []; },
      upstoxGetHistoricalV3: async () => { upstoxCalled = true; return [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] as never; },
    });
    const res = await fetcher({ ...chunkArgs, instrumentId: "NIFTY", provider: "angel_one" });
    expect(angelCalled).toBe(false);
    expect(upstoxCalled).toBe(true);
    expect(res.outcome).toBe("SUCCESS");
  });
});

// ── §24/§25 signal-surface authoritative data gate (fail-closed) ─────────────

describe("V7 §24/§25 — signal-surface data gate fails closed", () => {
  it("BLOCKS when a critical dependency is UNAVAILABLE", async () => {
    const { evaluateSignalSurfaceDataGate } = await import(
      "@/lib/market-data/services/signal-surface-data-gate.service"
    );
    const res = await evaluateSignalSurfaceDataGate({
      surface: "SignalHistory",
      dependencies: [{ name: "freshness", status: "UNAVAILABLE", critical: true }],
    });
    expect(res.allowed).toBe(false);
    expect(res.globalState).toBe("DATA_BLOCKED");
  });

  it("ALLOWS when all critical dependencies are AVAILABLE", async () => {
    const { evaluateSignalSurfaceDataGate } = await import(
      "@/lib/market-data/services/signal-surface-data-gate.service"
    );
    const res = await evaluateSignalSurfaceDataGate({
      surface: "APlusFactory",
      dependencies: [{ name: "ohlcv", status: "AVAILABLE", critical: true }],
    });
    expect(res.allowed).toBe(true);
  });

  it("BLOCKS on snapshot skew beyond tolerance", async () => {
    const { evaluateSignalSurfaceDataGate } = await import(
      "@/lib/market-data/services/signal-surface-data-gate.service"
    );
    const now = Date.now();
    const res = await evaluateSignalSurfaceDataGate({
      surface: "MLInference",
      dependencies: [{ name: "ohlcv", status: "AVAILABLE", critical: true }],
      snapshotFields: [
        { name: "candle", timestampMs: now, critical: true },
        { name: "oi", timestampMs: now - 5 * 60_000, critical: true },
      ],
      maxSkewMs: 60_000,
    });
    expect(res.allowed).toBe(false);
    expect(res.snapshotConsistent).toBe(false);
  });

  it("fails closed when NO dependencies are supplied (cannot verify)", async () => {
    const { evaluateSignalSurfaceDataGate } = await import(
      "@/lib/market-data/services/signal-surface-data-gate.service"
    );
    const res = await evaluateSignalSurfaceDataGate({ surface: "SignalHistory" });
    expect(res.allowed).toBe(false);
  });
});

// ── §27/§33 readiness matrix + overall status ────────────────────────────────

describe("V7 §27/§33 — readiness matrix gives exact reasons + honest overall", () => {
  it("BLOCKS with an exact history deficit reason (never generic)", async () => {
    const { buildFnoSignalReadinessMatrix, computeOverallDataStatus } = await import(
      "@/lib/market-data/services/signal-data-snapshot.service"
    );
    const snapshot = {
      snapshotId: "t", snapshotTimestamp: Date.now(), instrumentMasterVersion: "v1",
      symbols: [{
        symbol: "NIFTY", isIndex: true,
        coverage: [{ interval: "5m" as const, bars: 10, requiredBars: 620, sufficient: false, firstTime: 1, lastTime: 2, providers: ["upstox"] }],
        options: { strikeRows: 0, oiPopulated: 0, ivPopulated: 0, bidPopulated: 0, expiries: [] },
      }],
    };
    const matrix = buildFnoSignalReadinessMatrix(snapshot, [{ strategy: "ORB_5m", timeframe: "5m" }]);
    expect(matrix[0]!.state).toBe("BLOCKED");
    expect(matrix[0]!.reason).toContain("INSUFFICIENT_HISTORY");
    expect(matrix[0]!.reason).toContain("missing");
    const overall = computeOverallDataStatus(matrix);
    expect(overall.overallDataStatus).toBe("DATA_BLOCKED");
  });

  it("DEGRADED (not READY) when IV missing but history + OI present", async () => {
    const { buildFnoSignalReadinessMatrix } = await import(
      "@/lib/market-data/services/signal-data-snapshot.service"
    );
    const snapshot = {
      snapshotId: "t", snapshotTimestamp: Date.now(), instrumentMasterVersion: "v1",
      symbols: [{
        symbol: "NIFTY", isIndex: true,
        coverage: [{ interval: "5m" as const, bars: 5000, requiredBars: 620, sufficient: true, firstTime: 1, lastTime: 2, providers: ["upstox"] }],
        options: { strikeRows: 100, oiPopulated: 100, ivPopulated: 0, bidPopulated: 0, expiries: ["29-Sep-2026"] },
      }],
    };
    const matrix = buildFnoSignalReadinessMatrix(snapshot, [{ strategy: "option_IV", timeframe: "5m", needsOptions: true, needsIv: true }]);
    expect(matrix[0]!.state).toBe("DEGRADED");
    expect(matrix[0]!.reason).toContain("MISSING_IV");
  });

  it("overall is DATA_DEGRADED when some rows READY and some BLOCKED (never globally READY)", async () => {
    const { computeOverallDataStatus } = await import(
      "@/lib/market-data/services/signal-data-snapshot.service"
    );
    const overall = computeOverallDataStatus([
      { strategy: "A", symbol: "NIFTY", timeframe: "5m", state: "READY", reason: "", detail: { bars: 1, requiredBars: 1, optionOi: 0, optionIv: 0 } },
      { strategy: "B", symbol: "NIFTY", timeframe: "1d", state: "BLOCKED", reason: "", detail: { bars: 0, requiredBars: 1, optionOi: 0, optionIv: 0 } },
    ]);
    expect(overall.overallDataStatus).toBe("DATA_DEGRADED");
    expect(overall.perStrategyReadiness).toHaveLength(2);
  });
});

// ── §16 realtime-vs-historical reconciliation ────────────────────────────────

describe("V7 §16 — realtime reconciliation records divergence, never overwrites", () => {
  it("within tolerance → matched, no mismatch row", async () => {
    const { reconcileRealtimeVsHistorical } = await import(
      "@/lib/market-data/services/realtime-reconciliation.service"
    );
    let created = 0;
    const prisma = { realtimeHistoricalMismatch: { create: async () => { created++; } } } as never;
    const res = await reconcileRealtimeVsHistorical({
      symbol: "NIFTY", exchange: "NSE", interval: "5m",
      realtime: { time: 1, open: 100, high: 100, low: 100, close: 100.05, volume: 0 },
      historicalClose: 100.0, prisma,
    });
    expect(res.matched).toBe(true);
    expect(created).toBe(0);
  });

  it("beyond tolerance → records a mismatch (RECORDED_ONLY)", async () => {
    const { reconcileRealtimeVsHistorical } = await import(
      "@/lib/market-data/services/realtime-reconciliation.service"
    );
    let created = 0;
    const prisma = { realtimeHistoricalMismatch: { create: async () => { created++; } } } as never;
    const res = await reconcileRealtimeVsHistorical({
      symbol: "NIFTY", exchange: "NSE", interval: "5m",
      realtime: { time: 1, open: 100, high: 105, low: 100, close: 105, volume: 0 },
      historicalClose: 100.0, prisma,
    });
    expect(res.matched).toBe(false);
    expect(res.resolution).toBe("RECORDED_ONLY");
    expect(created).toBe(1);
  });
});
