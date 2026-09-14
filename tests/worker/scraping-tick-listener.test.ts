// @vitest-environment node
/**
 * Tests for worker/src/jobs/scraping-tick-listener.ts
 *
 * After the data-service2.0 centralization, this module is a no-op stub.
 * Both exported functions log a message and do nothing.
 */
import { describe, expect, it, vi } from "vitest";

const logInfo = vi.fn();

vi.mock("@worker/log", () => ({
  createLogger: (_scope: string) => ({
    info: (...args: unknown[]) => logInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: (_name: string) => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

describe("scraping-tick-listener (no-op stub)", () => {
  it("startScrapingTickListener is exported and is a function", async () => {
    vi.resetModules();
    const { startScrapingTickListener } = await import("@worker/jobs/scraping-tick-listener");
    expect(typeof startScrapingTickListener).toBe("function");
  });

  it("startScrapingTickListener logs a message and does nothing", async () => {
    vi.resetModules();
    logInfo.mockClear();
    const { startScrapingTickListener } = await import("@worker/jobs/scraping-tick-listener");
    const onTick = vi.fn();
    expect(() => startScrapingTickListener(onTick)).not.toThrow();
    // onTick should never be called — it's a no-op
    expect(onTick).not.toHaveBeenCalled();
  });

  it("stopScrapingTickListener is exported and is a function", async () => {
    vi.resetModules();
    const { stopScrapingTickListener } = await import("@worker/jobs/scraping-tick-listener");
    expect(typeof stopScrapingTickListener).toBe("function");
  });

  it("stopScrapingTickListener is a no-op", async () => {
    vi.resetModules();
    const { stopScrapingTickListener } = await import("@worker/jobs/scraping-tick-listener");
    expect(() => stopScrapingTickListener()).not.toThrow();
  });
});
