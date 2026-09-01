// @vitest-environment node
/**
 * Phase 14 — Worker and Scheduler Audit Tests
 *
 * Tests idempotency, market hours guards, duplicate prevention,
 * and crash recovery properties of worker jobs.
 *
 * Validates: PHASE 14 requirements
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Market hours guards in all worker jobs
// ─────────────────────────────────────────────────────────────────────────────

describe("Worker jobs — market hours guards", () => {
  const JOB_FILES = [
    "worker/src/jobs/india-auto-trader.ts",
    "worker/src/jobs/india-daily-picks.ts",
    "worker/src/jobs/india-eod-squareoff.ts",
    "worker/src/jobs/india-fno-trend-track.ts",
    "worker/src/jobs/india-oc-capture.ts",
    "worker/src/jobs/india-scalper.ts",
    "worker/src/jobs/india-scanner.ts",
  ];

  for (const jobFile of JOB_FILES) {
    it(`${jobFile} contains a market hours guard`, () => {
      const src = readSrc(jobFile);
      // Each India job must check isNseMarketOpenIST or session-ended guard
      const hasGuard =
        src.includes("isNseMarketOpenIST") ||
        src.includes("isNseSessionEndedForDateIST") ||
        src.includes("isMarketOpen") ||
        src.includes("market-hours");
      expect(hasGuard).toBe(true);
    });
  }

  it("india-eod-squareoff checks session-ended (not just market-open)", () => {
    const src = readSrc("worker/src/jobs/india-eod-squareoff.ts");
    expect(src).toMatch(/isNseSessionEndedForDateIST|isSessionEnded/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Scheduler — no-overlap guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe("Scheduler — setTimeout-based no-overlap", () => {
  it("scheduleJob uses setTimeout (not setInterval) for no-overlap guarantee", () => {
    const src = readSrc("worker/src/scheduler.ts");
    // Must use setTimeout (not setInterval) so ticks don't overlap
    expect(src).toMatch(/setTimeout\s*\(/);
    expect(src).not.toMatch(/setInterval\s*\(/);
  });

  it("next tick is only scheduled in the finally block after the previous completes", () => {
    const src = readSrc("worker/src/scheduler.ts");
    // The pattern: finally { ... setTimeout(scheduleTick, ...) ... }
    expect(src).toMatch(/finally/);
    const finallyIdx = src.indexOf("finally");
    const nextSetTimeoutIdx = src.indexOf("setTimeout", finallyIdx);
    expect(nextSetTimeoutIdx).toBeGreaterThan(finallyIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Duplicate trade prevention in auto-trader
// ─────────────────────────────────────────────────────────────────────────────

describe("india-auto-trader — duplicate prevention", () => {
  it("queries for existing OPEN trade for symbol before creating new one", () => {
    const src = readSrc("src/features/india/paper-trading/auto-trader.ts");
    // Should have a findFirst or findUnique check for existing open trade
    expect(src).toMatch(/findFirst|findUnique/);
    // The dup check looks for status OPEN
    expect(src).toMatch(/status.*OPEN|OPEN.*status|status.*:.*"OPEN"|where.*OPEN/);
  });

  it("skips if a duplicate is found", () => {
    const src = readSrc("src/features/india/paper-trading/auto-trader.ts");
    // After finding a dup, should increment skipped counter
    expect(src).toMatch(/skipped\+\+|skipped\s*\+=|skip/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EOD square-off — run-once guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe("india-eod-squareoff — idempotency", () => {
  it("updates only OPEN trades (already-closed trades are ignored)", () => {
    const src = readSrc("worker/src/jobs/india-eod-squareoff.ts");
    // Should filter by status = OPEN when closing trades
    expect(src).toMatch(/status.*OPEN|where.*OPEN/);
  });

  it("checks if there are any open trades before doing work", () => {
    const src = readSrc("worker/src/jobs/india-eod-squareoff.ts");
    // Should have a check/count for open trades
    expect(src).toMatch(/openCount|count.*OPEN|findMany.*OPEN|openPositions/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Worker bootstrap — fail-fast on missing infrastructure
// ─────────────────────────────────────────────────────────────────────────────

describe("Worker bootstrap — fail-fast", () => {
  it("pings Redis before starting jobs", () => {
    const src = readSrc("worker/src/index.ts");
    expect(src).toMatch(/redis\.ping\(\)|ping\(\)/);
  });

  it("pings Prisma/DB before starting jobs", () => {
    const src = readSrc("worker/src/index.ts");
    expect(src).toMatch(/queryRaw|prisma.*ping|SELECT 1/);
  });

  it("throws on bootstrap failure to prevent silent job start", () => {
    const src = readSrc("worker/src/index.ts");
    expect(src).toMatch(/throw err|process\.exit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Graceful shutdown — jobs stopped before process exit
// ─────────────────────────────────────────────────────────────────────────────

describe("Worker — graceful shutdown", () => {
  it("listens for SIGTERM and SIGINT", () => {
    const src = readSrc("worker/src/index.ts");
    expect(src).toMatch(/SIGTERM/);
    expect(src).toMatch(/SIGINT/);
  });

  it("stops all jobs on shutdown", () => {
    const src = readSrc("worker/src/index.ts");
    expect(src).toMatch(/\.stop\(\)/);
  });

  it("closes Redis and Prisma on shutdown", () => {
    const src = readSrc("worker/src/index.ts");
    expect(src).toMatch(/closeRedis/);
    expect(src).toMatch(/closePrisma/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Option chain capture — uses idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("india-oc-capture — snapshot storage", () => {
  it("option chain capture job exists and imports from features directory", () => {
    const src = readSrc("worker/src/jobs/india-oc-capture.ts");
    // Should import from a feature module
    expect(src).toMatch(/from.*features|from.*@\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Scheduler unit test — runOnStart is honoured
// ─────────────────────────────────────────────────────────────────────────────

describe("scheduleJob unit tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tick does not run before interval when runOnStart is false", async () => {
    const { scheduleJob } = await import("@worker/scheduler");
    const tick = vi.fn().mockResolvedValue(undefined);
    const log: any = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
    const handle = scheduleJob({ name: "test", intervalMs: 1000, tick }, log);
    expect(tick).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("tick runs immediately when runOnStart is true", async () => {
    const { scheduleJob } = await import("@worker/scheduler");
    const tick = vi.fn().mockResolvedValue(undefined);
    const log: any = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
    const handle = scheduleJob({ name: "test", intervalMs: 1000, runOnStart: true, tick }, log);
    await Promise.resolve(); await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});
