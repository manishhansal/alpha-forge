// @vitest-environment node
/**
 * Unit tests for worker/src/jobs/scraping-tick-listener.ts
 *
 * The listener module holds module-level state (_subscriber, _started).
 * Each test re-imports the module via vi.resetModules() so state is
 * fully isolated between cases.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.8
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Shared spy references ────────────────────────────────────────────────────
// vi.hoisted() runs before any vi.mock() factory, so these spies are
// available to all mock factories below.

const { logInfo, logWarn, logError } = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// ── Mock: @worker/log ────────────────────────────────────────────────────────
vi.mock("@worker/log", () => ({
  createLogger: (_scope: string) => ({
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
    error: (...args: unknown[]) => logError(...args),
    debug: vi.fn(),
    child: vi.fn(),
  }),
}));

// ── Mock: @worker/config ─────────────────────────────────────────────────────
// We expose `scrapingTicksEnabled` so individual tests can toggle it.
const { scrapingTicksEnabled } = vi.hoisted(() => ({
  scrapingTicksEnabled: { value: true },
}));

vi.mock("@worker/config", () => ({
  get workerConfig() {
    return {
      scrapingTicks: { enabled: scrapingTicksEnabled.value },
    };
  },
}));

// ── Mock: @worker/redis ──────────────────────────────────────────────────────
// Build a minimal mock Redis subscriber that:
//  - records .on(event, handler) so tests can emit events programmatically
//  - records .psubscribe() call for assertion
//  - exposes .punsubscribe() and .disconnect() as spies

type EventMap = Record<string, ((...args: unknown[]) => void)[]>;

function createMockSubscriberClient() {
  const eventHandlers: EventMap = {};
  const psubscribeSpy = vi.fn((_pattern: string, cb?: (err: Error | null, count: number) => void) => {
    // Simulate a successful psubscribe acknowledgement on next tick
    if (cb) {
      Promise.resolve().then(() => cb(null, 1));
    }
  });
  const punsubscribeSpy = vi.fn();
  const disconnectSpy = vi.fn();

  const client = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
      return client; // fluent
    },
    psubscribe: psubscribeSpy,
    punsubscribe: punsubscribeSpy,
    disconnect: disconnectSpy,
    /** Test helper — emit an event to all registered handlers. */
    _emit(event: string, ...args: unknown[]) {
      for (const handler of eventHandlers[event] ?? []) {
        handler(...args);
      }
    },
    _psubscribeSpy: psubscribeSpy,
    _punsubscribeSpy: punsubscribeSpy,
    _disconnectSpy: disconnectSpy,
  };

  return client;
}

// The factory variable is mutated per-test so each re-import gets a fresh
// mock instance.
let mockClientInstance: ReturnType<typeof createMockSubscriberClient>;

vi.mock("@worker/redis", () => ({
  createSubscriberClient: () => mockClientInstance,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Re-import the listener module with a clean module cache so module-level
 * state (_subscriber, _started) is reset for each test.
 */
async function importListener() {
  vi.resetModules();
  return await import("@worker/jobs/scraping-tick-listener");
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("scraping-tick-listener", () => {
  beforeEach(() => {
    mockClientInstance = createMockSubscriberClient();
    scrapingTicksEnabled.value = true;
    logInfo.mockReset();
    logWarn.mockReset();
    logError.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1 ──────────────────────────────────────────────────────────────
  it("calls onTick with parsed LiveTick on valid pmessage", async () => {
    const { startScrapingTickListener } = await importListener();

    const onTick = vi.fn();
    startScrapingTickListener(onTick);

    const liveTick = {
      token: "1234",
      symbol: "NIFTY",
      exchange: "NSE",
      ltp: 22500.5,
      change: 120.0,
      changePct: 0.54,
      volume: 1_000_000,
      oi: 500_000,
      exchangeTimestampMs: 1_700_000_000_000,
      receivedAtMs: 1_700_000_000_001,
      provider: "scrapling",
    };

    // Simulate a pmessage event from the Redis subscriber
    mockClientInstance._emit("pmessage", "af:ticks:*", "af:ticks:NIFTY", JSON.stringify(liveTick));

    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick).toHaveBeenCalledWith(liveTick);
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────
  it("logs warning and continues on JSON parse failure", async () => {
    const { startScrapingTickListener } = await importListener();

    const onTick = vi.fn();
    startScrapingTickListener(onTick);

    const malformedMessage = "{ this is not valid json }}}";

    // Emit a bad message
    mockClientInstance._emit("pmessage", "af:ticks:*", "af:ticks:RELIANCE", malformedMessage);

    // onTick must NOT have been called
    expect(onTick).not.toHaveBeenCalled();

    // A warning must have been logged with the channel name and raw message
    expect(logWarn).toHaveBeenCalledOnce();
    const [_msg, context] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toMatchObject({
      channel: "af:ticks:RELIANCE",
      message: malformedMessage,
    });

    // Listener should still be alive — send a valid message and verify it
    // is processed normally (i.e., did not crash)
    const validTick = {
      token: "5678",
      symbol: "RELIANCE",
      exchange: "NSE",
      ltp: 2800.0,
      change: null,
      changePct: null,
      volume: null,
      oi: null,
      exchangeTimestampMs: 1_700_000_001_000,
      receivedAtMs: 1_700_000_001_001,
      provider: "scrapling",
    };
    mockClientInstance._emit("pmessage", "af:ticks:*", "af:ticks:RELIANCE", JSON.stringify(validTick));
    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick).toHaveBeenCalledWith(validTick);
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────
  it("stopScrapingTickListener is safe to call when not started", async () => {
    const { stopScrapingTickListener } = await importListener();

    // Call stop before ever calling start — must not throw and must not
    // attempt to disconnect the (non-existent) subscriber.
    expect(() => stopScrapingTickListener()).not.toThrow();
    expect(mockClientInstance._disconnectSpy).not.toHaveBeenCalled();
    expect(mockClientInstance._punsubscribeSpy).not.toHaveBeenCalled();
  });

  // ── Test 4 ──────────────────────────────────────────────────────────────
  it("does not start when scrapingTicks.enabled is false", async () => {
    scrapingTicksEnabled.value = false;

    const { startScrapingTickListener } = await importListener();

    const onTick = vi.fn();
    startScrapingTickListener(onTick);

    // The listener must not have called psubscribe at all
    expect(mockClientInstance._psubscribeSpy).not.toHaveBeenCalled();

    // No pmessage handlers registered — emitting should be a no-op
    mockClientInstance._emit("pmessage", "af:ticks:*", "af:ticks:NIFTY", JSON.stringify({ symbol: "NIFTY" }));
    expect(onTick).not.toHaveBeenCalled();
  });
});
