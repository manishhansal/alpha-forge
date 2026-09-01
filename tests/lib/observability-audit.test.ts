// @vitest-environment node
/**
 * Phase 21 — Observability Audit Tests
 *
 * Verifies structured observability:
 *   1. mdLog emits structured JSON with ts, event, and payload fields
 *   2. Signal lifecycle fields are traceable (marketDataId → ... → fillId)
 *   3. Worker observability (Sentry init) is present
 *   4. Every provider failure emits a structured log
 *   5. Circuit breaker state changes emit structured logs
 *
 * Validates: PHASE 21 requirements — observability
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. mdLog — structured JSON logging
// ─────────────────────────────────────────────────────────────────────────────

describe("mdLog — structured JSON observability", () => {
  it("mdLog emits valid JSON with ts, event, and payload fields", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { mdLog } = await import("@/lib/market-data/health");

    mdLog("provider_failure", {
      providerId: "angel_one",
      kind: "api_error",
      consecutiveFailures: 2,
      score: 85,
      message: "test failure",
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const emitted = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(emitted);

    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("event", "provider_failure");
    expect(parsed).toHaveProperty("providerId", "angel_one");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
  });

  it("mdLog emits provider_circuit_open when circuit opens", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { recordFailure, resetHealth } = await import("@/lib/market-data/health");
    resetHealth("nse");

    // Trigger circuit open
    for (let i = 0; i < 8; i++) {
      recordFailure("nse", "api_error");
    }

    const circuitOpenEvent = consoleSpy.mock.calls
      .map((args) => {
        try { return JSON.parse(args[0]); } catch { return null; }
      })
      .find((parsed) => parsed?.event === "provider_circuit_open");

    expect(circuitOpenEvent).toBeDefined();
    expect(circuitOpenEvent.providerId).toBe("nse");
    resetHealth("nse");
  });

  it("mdLog emits provider_recovery when circuit closes", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { recordFailure, recordSuccess, resetHealth } = await import(
      "@/lib/market-data/health"
    );
    resetHealth("upstox");

    // Open circuit
    for (let i = 0; i < 8; i++) recordFailure("upstox", "api_error");
    // Close it
    recordSuccess("upstox", 50);

    const recoveryEvent = consoleSpy.mock.calls
      .map((args) => {
        try { return JSON.parse(args[0]); } catch { return null; }
      })
      .find((parsed) => parsed?.event === "provider_recovery");

    expect(recoveryEvent).toBeDefined();
    resetHealth("upstox");
  });

  it("mdLog emits failover event when switching providers", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { mdLog } = await import("@/lib/market-data/health");

    mdLog("provider_failover", {
      operationId: "getLatestQuote",
      from: "angel_one",
      to: "upstox",
      reason: "api_error",
      consecutiveAttempts: 3,
    });

    const emitted = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(emitted);
    expect(parsed.event).toBe("provider_failover");
    expect(parsed.from).toBe("angel_one");
    expect(parsed.to).toBe("upstox");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Signal lifecycle fields — traceability
// ─────────────────────────────────────────────────────────────────────────────

describe("Signal lifecycle — attribution traceability", () => {
  it("FillEvent has signalTimestampMs and executionTimestampMs for trace", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/backtesting-v2/events/fill-event.ts"),
      "utf-8"
    );
    expect(src).toMatch(/signalTimestampMs/);
    expect(src).toMatch(/executionTimestampMs/);
  });

  it("Position attribution includes strategyId and signalId", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/backtesting-v2/models/position.ts"),
      "utf-8"
    );
    expect(src).toMatch(/strategyId/);
    expect(src).toMatch(/signalId|signalEventId/);
  });

  it("PositionAttribution includes modelVersion and featureVersion", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/backtesting-v2/models/position.ts"),
      "utf-8"
    );
    expect(src).toMatch(/modelVersion/);
    expect(src).toMatch(/featureVersion/);
  });

  it("ML responses include model_version for provenance", () => {
    // regime response has model_version field (per schemas.py)
    const src = readFileSync(
      join(process.cwd(), "ml-service/src/schemas.py"),
      "utf-8"
    );
    expect(src).toMatch(/model_version/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Worker observability
// ─────────────────────────────────────────────────────────────────────────────

describe("Worker observability — Sentry integration", () => {
  it("worker index initialises observability before any job starts", () => {
    const src = readFileSync(
      join(process.cwd(), "worker/src/index.ts"),
      "utf-8"
    );
    expect(src).toMatch(/initObservability/);
    // Sentry init must appear before bootstrap()
    const initIdx = src.indexOf("initObservability");
    const bootstrapIdx = src.indexOf("bootstrap()");
    expect(initIdx).toBeLessThan(bootstrapIdx);
  });

  it("worker observability.ts exports initObservability and captureError", () => {
    const src = readFileSync(
      join(process.cwd(), "worker/src/observability.ts"),
      "utf-8"
    );
    expect(src).toMatch(/export.*initObservability/);
    expect(src).toMatch(/export.*captureError/);
  });

  it("worker flushes observability on shutdown", () => {
    const src = readFileSync(
      join(process.cwd(), "worker/src/index.ts"),
      "utf-8"
    );
    expect(src).toMatch(/flushObservability/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Structured logging — event types are predefined
// ─────────────────────────────────────────────────────────────────────────────

describe("Structured logging — predefined event types", () => {
  it("health.ts defines a LogEvent union type for all observable events", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/health.ts"),
      "utf-8"
    );
    expect(src).toMatch(/type LogEvent/);
    expect(src).toMatch(/provider_selected/);
    expect(src).toMatch(/provider_failure/);
    expect(src).toMatch(/provider_failover/);
    expect(src).toMatch(/provider_recovery/);
    expect(src).toMatch(/provider_circuit_open/);
    expect(src).toMatch(/stale_data/);
    expect(src).toMatch(/data_mismatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Candle builder — every error is logged (not silently swallowed)
// ─────────────────────────────────────────────────────────────────────────────

describe("Candle builder observability", () => {
  it("logs Redis write failures instead of silently swallowing them", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/services/candle-builder.service.ts"),
      "utf-8"
    );
    expect(src).toMatch(/redis_write_failed/);
    expect(src).toMatch(/db_write_failed/);
    expect(src).toMatch(/candle_restore_failed/);
  });

  it("logs late ticks that are tolerated or dropped", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/market-data/services/candle-builder.service.ts"),
      "utf-8"
    );
    expect(src).toMatch(/late_tick_dropped/);
    expect(src).toMatch(/late_tick_tolerated/);
  });
});
