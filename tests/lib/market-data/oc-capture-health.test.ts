/**
 * OC capture health monitoring — regression tests (RCA-002)
 *
 * Verifies that:
 *   1. OC_LAST_CAPTURE_KEY is set in Redis after a successful capture.
 *   2. The staleness guard detects a gap > 15 minutes.
 *   3. Redis unavailability is handled gracefully (no crash).
 *
 * Fix: RCA-002 — OC snapshot gap 12:51–15:30 IST not detected or alerted
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock the imports used by india-oc-capture ─────────────────────────────────

vi.mock("@/features/india/scalping/option-chain-capture", () => ({
  captureOptionChainSnapshots: vi.fn(),
}));

vi.mock("@/lib/india/market-hours", () => ({
  isNseMarketOpenIST: vi.fn(() => true),
}));

vi.mock("server-only", () => ({}));

// Expose the Redis mock so tests can control it.
const redisMock = {
  set: vi.fn().mockResolvedValue("OK"),
  get: vi.fn().mockResolvedValue(null),
};

vi.mock("../../../worker/src/redis", () => ({
  getRedis: () => redisMock,
}));

vi.mock("../../../worker/src/log", () => ({
  createLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: warnSpy,
    }),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock("../../../worker/src/scheduler", () => ({
  scheduleJob: (_config: { tick: () => Promise<void> }) => ({
    name: "india-oc-capture",
    stop: async () => {},
    // Expose tick for direct testing.
    _tick: _config.tick,
  }),
}));

vi.mock("../../../worker/src/config", () => ({
  workerConfig: {
    indiaOptionChainCapture: { intervalMs: 300_000 },
  },
}));

const warnSpy = vi.fn();

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("india-oc-capture health monitoring — RCA-002 regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue("OK");
  });

  it("records success timestamp in Redis after a successful capture", async () => {
    const { captureOptionChainSnapshots } = await import(
      "@/features/india/scalping/option-chain-capture"
    );
    (captureOptionChainSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue({
      captured: 4,
      errors: 0,
    });

    const { startIndiaOptionChainCaptureJob } = await import(
      "../../../worker/src/jobs/india-oc-capture"
    );
    const job = startIndiaOptionChainCaptureJob() as unknown as { _tick: () => Promise<void> };
    await job._tick();

    // Redis.set should have been called with the last-success key.
    expect(redisMock.set).toHaveBeenCalledWith(
      "india:oc-capture:last-success-ms",
      expect.any(String),
      "EX",
      3600,
    );
  });

  it("does NOT record success when captured === 0", async () => {
    const { captureOptionChainSnapshots } = await import(
      "@/features/india/scalping/option-chain-capture"
    );
    (captureOptionChainSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue({
      captured: 0,
      errors: 2,
    });

    const { startIndiaOptionChainCaptureJob } = await import(
      "../../../worker/src/jobs/india-oc-capture"
    );
    const job = startIndiaOptionChainCaptureJob() as unknown as { _tick: () => Promise<void> };
    await job._tick();

    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("emits oc_capture_stale warn when last capture was >15 min ago", async () => {
    const { captureOptionChainSnapshots } = await import(
      "@/features/india/scalping/option-chain-capture"
    );
    (captureOptionChainSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue({
      captured: 4,
      errors: 0,
    });

    // Simulate last capture 20 minutes ago.
    const staleMs = Date.now() - 20 * 60_000;
    redisMock.get.mockResolvedValue(String(staleMs));

    const { startIndiaOptionChainCaptureJob } = await import(
      "../../../worker/src/jobs/india-oc-capture"
    );
    const job = startIndiaOptionChainCaptureJob() as unknown as { _tick: () => Promise<void> };
    await job._tick();

    expect(warnSpy).toHaveBeenCalledWith(
      "oc_capture_stale",
      expect.objectContaining({
        ageMs: expect.any(Number),
        thresholdMs: 15 * 60_000,
        alert: expect.stringContaining("OC snapshots have not been captured"),
      }),
    );
  });

  it("does NOT warn when last capture was within 15 minutes", async () => {
    const { captureOptionChainSnapshots } = await import(
      "@/features/india/scalping/option-chain-capture"
    );
    (captureOptionChainSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue({
      captured: 4,
      errors: 0,
    });

    // Simulate last capture 5 minutes ago — within threshold.
    const recentMs = Date.now() - 5 * 60_000;
    redisMock.get.mockResolvedValue(String(recentMs));

    const { startIndiaOptionChainCaptureJob } = await import(
      "../../../worker/src/jobs/india-oc-capture"
    );
    const job = startIndiaOptionChainCaptureJob() as unknown as { _tick: () => Promise<void> };
    await job._tick();

    expect(warnSpy).not.toHaveBeenCalledWith("oc_capture_stale", expect.anything());
  });

  it("handles Redis unavailability gracefully — no crash", async () => {
    const { captureOptionChainSnapshots } = await import(
      "@/features/india/scalping/option-chain-capture"
    );
    (captureOptionChainSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue({
      captured: 4,
      errors: 0,
    });

    // Simulate Redis throwing on every call.
    redisMock.set.mockRejectedValue(new Error("Redis connection refused"));
    redisMock.get.mockRejectedValue(new Error("Redis connection refused"));

    const { startIndiaOptionChainCaptureJob } = await import(
      "../../../worker/src/jobs/india-oc-capture"
    );
    const job = startIndiaOptionChainCaptureJob() as unknown as { _tick: () => Promise<void> };

    // Must not throw.
    await expect(job._tick()).resolves.toBeUndefined();
  });
});
