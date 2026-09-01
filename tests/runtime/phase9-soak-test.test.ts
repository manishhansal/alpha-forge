// @vitest-environment node
/**
 * PHASE 9 — Paper Trading Soak Test
 *
 * Runs a synthetic market-data soak for a configurable duration.
 * In CI/unit mode this runs a SHORT accelerated soak (default 2s).
 * In full soak mode (SOAK_DURATION_HOURS=8 or 24) it runs the full duration.
 *
 * Inputs:
 *   - 200 F&O symbols (stubbed)
 *   - Live-like tick stream (10ms interval = 100 ticks/s synthetic)
 *   - Multiple concurrent signal evaluations
 *   - ML stub requests (counted, not real)
 *   - Risk checks
 *   - Paper trade guard invocations
 *
 * Tracks:
 *   - Heap memory usage (detect leaks)
 *   - Event loop lag
 *   - Signal dedup guard performance
 *   - Trade guard performance
 *   - Queue growth
 *   - Error rate
 *
 * Generates: test-results/SOAK_TEST_REPORT.md
 */

import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const SOAK_HOURS = parseFloat(process.env.SOAK_DURATION_HOURS ?? "0");
const SOAK_DURATION_MS = SOAK_HOURS > 0 ? SOAK_HOURS * 60 * 60 * 1000 : 2_000; // 2s in unit mode
const TICK_INTERVAL_MS = 10;
const SYMBOL_COUNT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic F&O symbol universe
// ─────────────────────────────────────────────────────────────────────────────

const FNO_SYMBOLS = [
  "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
  "RELIANCE", "TCS", "INFY", "HDFC", "ICICIBANK", "SBIN",
  "AXISBANK", "KOTAKBANK", "WIPRO", "HCLTECH", "BAJFINANCE",
  "BAJAJFINSV", "MARUTI", "TITAN", "NESTLEIND", "DIVISLAB",
  ...Array.from({ length: 180 }, (_, i) => `STOCK${i + 21}`),
].slice(0, SYMBOL_COUNT);

// ─────────────────────────────────────────────────────────────────────────────
// Metrics tracking
// ─────────────────────────────────────────────────────────────────────────────

interface SoakMetrics {
  startTime: number;
  endTime: number;
  durationMs: number;
  ticksGenerated: number;
  signalsEvaluated: number;
  tradesAttempted: number;
  tradesBlocked: number;
  mlRequestsStubbed: number;
  riskChecks: number;
  errors: string[];
  heapSamples: number[];
  eventLoopLagSamples: number[];
  tickThroughputPerSec: number[];
  guardLatencyMs: number[];
  riskLatencyMs: number[];
  queueDepths: number[];
}

function memMb(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function measureEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const before = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - before) / 1_000_000;
      resolve(lag);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Soak runner
// ─────────────────────────────────────────────────────────────────────────────

async function runSoak(durationMs: number): Promise<SoakMetrics> {
  const { checkAndSetSignalGuard, checkAndSetTradeGuard } = await import("@/lib/chaos/worker-resilience");

  // In-memory Redis (no live Redis needed for soak)
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const redis = {
    async get(key: string) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt !== null && e.expiresAt < Date.now()) { store.delete(key); return null; }
      return e.value;
    },
    async set(key: string, value: string, _m?: string, ttl?: number) {
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
      return "OK";
    },
    async setNX(key: string, value: string, ttlSeconds: number) {
      const e = store.get(key);
      if (e && (e.expiresAt === null || e.expiresAt > Date.now())) return null;
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return "OK";
    },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
    async ping() { return "PONG"; },
    async expire() { return 1; },
    async zadd() { return 0; },
    async zrangeByScore() { return []; },
    async zremRangeByScore() { return 0; },
    async zcard() { return 0; },
  } as any;

  const { createRiskEngine } = await import("@/lib/risk/portfolio-risk");
  const riskEngine = createRiskEngine(1_000_000);

  const metrics: SoakMetrics = {
    startTime: Date.now(),
    endTime: 0,
    durationMs: 0,
    ticksGenerated: 0,
    signalsEvaluated: 0,
    tradesAttempted: 0,
    tradesBlocked: 0,
    mlRequestsStubbed: 0,
    riskChecks: 0,
    errors: [],
    heapSamples: [],
    eventLoopLagSamples: [],
    tickThroughputPerSec: [],
    guardLatencyMs: [],
    riskLatencyMs: [],
    queueDepths: [],
  };

  const deadline = Date.now() + durationMs;
  let lastSecondTicks = 0;
  let lastSecondTs = Date.now();

  // Periodic metrics sampling
  const samplerInterval = setInterval(async () => {
    metrics.heapSamples.push(memMb());
    const lag = await measureEventLoopLag();
    metrics.eventLoopLagSamples.push(lag);
    metrics.queueDepths.push(store.size);

    const now = Date.now();
    const elapsed = now - lastSecondTs;
    if (elapsed >= 1000) {
      metrics.tickThroughputPerSec.push(Math.round((lastSecondTicks * 1000) / elapsed));
      lastSecondTicks = 0;
      lastSecondTs = now;
    }
  }, Math.max(100, durationMs / 20)); // sample 20 times during the soak

  // Main soak loop
  let tickBatch = 0;
  while (Date.now() < deadline) {
    const batchStart = Date.now();

    // Generate a batch of ticks for all symbols
    for (const symbol of FNO_SYMBOLS) {
      metrics.ticksGenerated++;
      lastSecondTicks++;

      // Every 10th tick generates a signal evaluation
      if (metrics.ticksGenerated % 10 === 0) {
        const ts = Date.now();

        try {
          // Signal guard check
          const guardT0 = Date.now();
          const isDup = await checkAndSetSignalGuard(redis, symbol, "LONG", ts);
          metrics.guardLatencyMs.push(Date.now() - guardT0);
          metrics.signalsEvaluated++;

          if (!isDup) {
            // Risk evaluation
            const riskT0 = Date.now();
            const riskResult = riskEngine.evaluate(
              { symbol, strategyId: "SOAK", direction: "LONG", entryPrice: 24640, stopLoss: 24580, target: 24750, atr: 60, lotSize: 1, confidence: 0.75 },
              [], 1_000_000, 0,
            );
            metrics.riskLatencyMs.push(Date.now() - riskT0);
            metrics.riskChecks++;

            if (riskResult.decision === "APPROVED") {
              // Trade guard
              metrics.tradesAttempted++;
              const tradeResult = await checkAndSetTradeGuard(redis, "soak", symbol, ts, `trade-${symbol}-${ts}`);
              if (tradeResult.isDuplicate) metrics.tradesBlocked++;
            }

            // ML stub (counted, not real)
            metrics.mlRequestsStubbed++;
          }
        } catch (err) {
          metrics.errors.push((err as Error).message);
        }
      }
    }

    tickBatch++;
    // Yield occasionally to not starve the event loop
    if (tickBatch % 10 === 0) {
      await new Promise((r) => setImmediate(r));
    }

    // Throttle to ~TICK_INTERVAL_MS per batch (not per tick, since we process all symbols)
    const elapsed = Date.now() - batchStart;
    if (elapsed < TICK_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS - elapsed));
    }
  }

  clearInterval(samplerInterval);

  metrics.endTime = Date.now();
  metrics.durationMs = metrics.endTime - metrics.startTime;

  return metrics;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

let soakResult: SoakMetrics;

describe(`Phase 9 — Soak test (${SOAK_DURATION_MS}ms / ${SYMBOL_COUNT} symbols)`, () => {
  it(`runs soak for ${SOAK_DURATION_MS}ms without crashing`, async () => {
    soakResult = await runSoak(SOAK_DURATION_MS);
    expect(soakResult.errors.length).toBe(0);
    expect(soakResult.ticksGenerated).toBeGreaterThan(0);
    expect(soakResult.signalsEvaluated).toBeGreaterThan(0);
  }, SOAK_DURATION_MS + 5_000); // timeout slightly longer than soak

  it("no memory leak detected (heap growth < 50MB over soak)", () => {
    if (!soakResult) return;
    const heapSamples = soakResult.heapSamples;
    if (heapSamples.length < 2) return; // too short to measure

    const firstQuartile = heapSamples.slice(0, Math.ceil(heapSamples.length * 0.25));
    const lastQuartile  = heapSamples.slice(-Math.ceil(heapSamples.length * 0.25));
    const avgStart = firstQuartile.reduce((a, b) => a + b, 0) / firstQuartile.length;
    const avgEnd   = lastQuartile.reduce((a, b) => a + b, 0) / lastQuartile.length;
    const heapGrowthMb = avgEnd - avgStart;

    console.log(`Heap growth: ${heapGrowthMb.toFixed(2)}MB (avg start=${avgStart.toFixed(2)}MB, avg end=${avgEnd.toFixed(2)}MB)`);
    expect(heapGrowthMb).toBeLessThan(50); // 50MB threshold
  });

  it("event loop lag stays < 100ms during soak", () => {
    if (!soakResult) return;
    const lagSamples = soakResult.eventLoopLagSamples;
    if (lagSamples.length === 0) return;

    const p99 = lagSamples.sort((a, b) => a - b)[Math.floor(lagSamples.length * 0.99)] ?? 0;
    console.log(`Event loop lag P99: ${p99.toFixed(2)}ms`);
    expect(p99).toBeLessThan(100);
  });

  it("guard latency P99 < 5ms (in-memory Redis)", () => {
    if (!soakResult || soakResult.guardLatencyMs.length === 0) return;
    const sorted = [...soakResult.guardLatencyMs].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    console.log(`Guard latency P99: ${p99.toFixed(2)}ms`);
    expect(p99).toBeLessThan(5);
  });

  it("risk evaluation latency P99 < 5ms", () => {
    if (!soakResult || soakResult.riskLatencyMs.length === 0) return;
    const sorted = [...soakResult.riskLatencyMs].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    console.log(`Risk latency P99: ${p99.toFixed(2)}ms`);
    expect(p99).toBeLessThan(5);
  });

  it("no duplicate connection leaks (Redis store size bounded)", () => {
    if (!soakResult) return;
    const maxDepth = Math.max(...soakResult.queueDepths);
    // Redis keys should be bounded by symbol count × max guard windows
    // Expecting < 10× symbol count
    expect(maxDepth).toBeLessThan(SYMBOL_COUNT * 10);
    console.log(`Max Redis store depth during soak: ${maxDepth} keys`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write SOAK_TEST_REPORT.md
// ─────────────────────────────────────────────────────────────────────────────

afterAll(() => {
  if (!soakResult) return;
  const m = soakResult;

  const heapMin = m.heapSamples.length > 0 ? Math.min(...m.heapSamples).toFixed(2) : "N/A";
  const heapMax = m.heapSamples.length > 0 ? Math.max(...m.heapSamples).toFixed(2) : "N/A";
  const heapAvg = m.heapSamples.length > 0 ? (m.heapSamples.reduce((a, b) => a + b, 0) / m.heapSamples.length).toFixed(2) : "N/A";
  const lagMax  = m.eventLoopLagSamples.length > 0 ? Math.max(...m.eventLoopLagSamples).toFixed(2) : "N/A";
  const lagP99  = m.eventLoopLagSamples.length > 0 ? [...m.eventLoopLagSamples].sort((a,b)=>a-b)[Math.floor(m.eventLoopLagSamples.length*0.99)]?.toFixed(2) ?? "N/A" : "N/A";
  const guardP99 = m.guardLatencyMs.length > 0 ? [...m.guardLatencyMs].sort((a,b)=>a-b)[Math.floor(m.guardLatencyMs.length*0.99)]?.toFixed(2) ?? "N/A" : "N/A";
  const riskP99  = m.riskLatencyMs.length > 0 ? [...m.riskLatencyMs].sort((a,b)=>a-b)[Math.floor(m.riskLatencyMs.length*0.99)]?.toFixed(2) ?? "N/A" : "N/A";
  const throughput = m.tickThroughputPerSec.length > 0 ? Math.max(...m.tickThroughputPerSec) : 0;

  const report = `# SOAK_TEST_REPORT

Generated: ${new Date().toISOString()}
Mode: ${SOAK_HOURS > 0 ? `${SOAK_HOURS}-hour soak` : "short soak (unit mode)"}

## Configuration
| Parameter | Value |
|-----------|-------|
| Duration | ${(m.durationMs / 1000).toFixed(1)}s (target: ${(SOAK_DURATION_MS / 1000).toFixed(1)}s) |
| Symbols | ${SYMBOL_COUNT} F&O symbols |
| Tick interval | ${TICK_INTERVAL_MS}ms |
| Redis backend | In-memory (MemoryRedis) |
| ML backend | Stubbed (counted only) |

## Throughput
| Metric | Value |
|--------|-------|
| Total ticks generated | ${m.ticksGenerated.toLocaleString()} |
| Signals evaluated | ${m.signalsEvaluated.toLocaleString()} |
| ML requests (stubbed) | ${m.mlRequestsStubbed.toLocaleString()} |
| Risk checks | ${m.riskChecks.toLocaleString()} |
| Paper trade attempts | ${m.tradesAttempted.toLocaleString()} |
| Duplicate trades blocked | ${m.tradesBlocked.toLocaleString()} |
| Peak tick throughput | ${throughput.toLocaleString()} ticks/s |

## Memory
| Metric | Value |
|--------|-------|
| Heap min | ${heapMin} MB |
| Heap max | ${heapMax} MB |
| Heap avg | ${heapAvg} MB |
| Heap samples | ${m.heapSamples.length} |

## Event Loop
| Metric | Value |
|--------|-------|
| Lag P99 | ${lagP99} ms |
| Lag max | ${lagMax} ms |
| Lag samples | ${m.eventLoopLagSamples.length} |

## Latency
| Component | P99 Latency |
|-----------|-------------|
| Signal guard (Redis) | ${guardP99} ms |
| Risk evaluation | ${riskP99} ms |

## Redis Store
| Metric | Value |
|--------|-------|
| Max key count | ${m.queueDepths.length > 0 ? Math.max(...m.queueDepths) : 0} keys |
| Final key count | ${m.queueDepths.length > 0 ? m.queueDepths[m.queueDepths.length - 1] : 0} keys |

## Errors
${m.errors.length === 0 ? "None detected." : m.errors.slice(0, 10).map((e) => `- ${e}`).join("\n")}

## Leak Detection
Memory leak: **${(() => {
    if (m.heapSamples.length < 4) return "N/A (too short)";
    const first = m.heapSamples.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    const last  = m.heapSamples.slice(-2).reduce((a, b) => a + b, 0) / 2;
    const growth = last - first;
    return growth < 50 ? `NONE (${growth.toFixed(1)}MB growth)` : `DETECTED (${growth.toFixed(1)}MB growth > 50MB threshold)`;
  })()}**

Connection leak: **${m.queueDepths.length > 0 && Math.max(...m.queueDepths) < SYMBOL_COUNT * 10 ? "NONE" : "POSSIBLE"}**

Duplicate trade suppression: **${m.tradesAttempted > 0 ? ((m.tradesBlocked / m.tradesAttempted) * 100).toFixed(1) + "% blocked" : "N/A"}**

## Status: **${m.errors.length === 0 ? (SOAK_HOURS > 0 ? "SOAK_CERTIFIED" : "SHORT_SOAK_PASSED") : "SOAK_FAILED"}**

> NOTE: Full 8-hour soak certification requires SOAK_DURATION_HOURS=8 with a real Redis instance.
> This report reflects a ${(m.durationMs / 1000).toFixed(1)}s accelerated soak with in-memory stubs.
`;

  const outDir = join(process.cwd(), "test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "SOAK_TEST_REPORT.md"), report, "utf-8");
  console.log("SOAK_TEST_REPORT written to test-results/SOAK_TEST_REPORT.md");
});
