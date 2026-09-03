// @vitest-environment node
/**
 * Property-Based Tests for worker/src/jobs/scraping-tick-listener.ts
 *
 * **Validates: Requirements 6.2**
 *
 * Property 13: Tick Listener Forwards Every Valid Message
 *
 * For any JSON-parseable message received on any `af:ticks:*` Redis pub/sub
 * channel, the `onTick` callback SHALL be called exactly once with the parsed
 * `LiveTick` object before the next message from the same channel is
 * processed. The `symbol` field of the `LiveTick` passed to `onTick` SHALL
 * equal the channel suffix (the portion of `af:ticks:{symbol}` after the
 * final `:`).
 *
 * Test data is generated programmatically using `it.each` to cover a
 * variety of LiveTick shapes, symbols, and edge cases without requiring
 * an external property-based testing library.
 *
 * The mock pattern mirrors `tests/worker/scraping-tick-listener.test.ts`
 * exactly: vi.resetModules() + dynamic import per test for full module
 * isolation of the listener's module-level state (_subscriber, _started).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveTick } from "@/lib/market-data/types";

// ── Shared spy references ────────────────────────────────────────────────────

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

vi.mock("@worker/config", () => ({
  get workerConfig() {
    return {
      scrapingTicks: { enabled: true },
    };
  },
}));

// ── Mock: @worker/redis ──────────────────────────────────────────────────────

type EventMap = Record<string, ((...args: unknown[]) => void)[]>;

function createMockSubscriberClient() {
  const eventHandlers: EventMap = {};
  const psubscribeSpy = vi.fn(
    (_pattern: string, cb?: (err: Error | null, count: number) => void) => {
      if (cb) {
        Promise.resolve().then(() => cb(null, 1));
      }
    },
  );
  const punsubscribeSpy = vi.fn();
  const disconnectSpy = vi.fn();

  const client = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
      return client;
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

let mockClientInstance: ReturnType<typeof createMockSubscriberClient>;

vi.mock("@worker/redis", () => ({
  createSubscriberClient: () => mockClientInstance,
}));

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Re-import the listener module with a clean module cache so module-level
 * state (_subscriber, _started) is reset for each test.
 */
async function importListener() {
  vi.resetModules();
  return await import("@worker/jobs/scraping-tick-listener");
}

/** Build a minimal but structurally complete LiveTick for a given symbol/ltp. */
function buildTick(symbol: string, ltp: number, overrides: Partial<LiveTick> = {}): LiveTick {
  return {
    token: `tok-${symbol}`,
    symbol,
    exchange: "NSE",
    ltp,
    change: null,
    changePct: null,
    volume: null,
    oi: null,
    exchangeTimestampMs: 1_700_000_000_000,
    receivedAtMs: 1_700_000_000_001,
    provider: "scrapling",
    ...overrides,
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

/**
 * A corpus of (symbol, ltp) pairs that represent realistic and edge-case
 * inputs for parameterised tests.
 */
const VALID_TICK_CORPUS: Array<{ symbol: string; ltp: number; desc: string }> = [
  { symbol: "NIFTY",     ltp: 22500.5,   desc: "NIFTY index — fractional ltp" },
  { symbol: "BANKNIFTY", ltp: 48320.0,   desc: "BANKNIFTY — large round number" },
  { symbol: "RELIANCE",  ltp: 2840.75,   desc: "equity — mid-cap fractional" },
  { symbol: "AAPL123",   ltp: 1.0,       desc: "alphanumeric symbol — minimum ltp" },
  { symbol: "INFY",      ltp: 1800.25,   desc: "IT stock" },
  { symbol: "NIFTY",     ltp: 99999.99,  desc: "NIFTY — large fractional ltp" },
  { symbol: "BANKNIFTY", ltp: 0.01,      desc: "BANKNIFTY — very small ltp" },
  { symbol: "RELIANCE",  ltp: 100.0,     desc: "RELIANCE — round number" },
];

// ── Suites ────────────────────────────────────────────────────────────────────

describe("Property 13: Tick Listener Forwards Every Valid Message", () => {
  beforeEach(() => {
    mockClientInstance = createMockSubscriberClient();
    logInfo.mockReset();
    logWarn.mockReset();
    logError.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Property 13a: onTick called exactly once per valid message ────────────
  //
  // For any JSON-parseable message on `af:ticks:{SYMBOL}`, the `onTick`
  // callback SHALL be called exactly once with the parsed LiveTick object.
  //
  describe("13a — onTick called exactly once per valid pmessage", () => {
    it.each(VALID_TICK_CORPUS)(
      "$desc (symbol=$symbol, ltp=$ltp)",
      async ({ symbol, ltp }) => {
        const { startScrapingTickListener } = await importListener();
        const onTick = vi.fn();
        startScrapingTickListener(onTick);

        const tick = buildTick(symbol, ltp);
        const channel = `af:ticks:${symbol}`;

        mockClientInstance._emit("pmessage", "af:ticks:*", channel, JSON.stringify(tick));

        // Exactly one call — no duplicate, no miss.
        expect(onTick).toHaveBeenCalledTimes(1);
        // Called with the fully parsed object — deep equality.
        expect(onTick).toHaveBeenCalledWith(tick);
      },
    );
  });

  // ── Property 13b: parsed payload fields are preserved intact ─────────────
  //
  // The parsed JSON fields SHALL be passed through unmodified. This validates
  // the second clause of Property 13: the `symbol` field in the tick object
  // is whatever the JSON contains (not overridden), i.e. the payload is not
  // mutated during forwarding.
  //
  describe("13b — parsed JSON fields are forwarded unmodified", () => {
    /** Extended tick shapes that cover field variety */
    const RICH_TICK_CORPUS: Array<{ label: string; tick: LiveTick }> = [
      {
        label: "all optional fields present",
        tick: buildTick("NIFTY", 22500.5, {
          change: 120.0,
          changePct: 0.54,
          volume: 1_000_000,
          oi: 500_000,
        }),
      },
      {
        label: "all optional fields null",
        tick: buildTick("BANKNIFTY", 48320.0),
      },
      {
        label: "zero volume and zero OI",
        tick: buildTick("RELIANCE", 2840.75, { volume: 0, oi: 0 }),
      },
      {
        label: "very large exchangeTimestampMs",
        tick: buildTick("INFY", 1800.25, {
          exchangeTimestampMs: Number.MAX_SAFE_INTEGER,
          receivedAtMs: Number.MAX_SAFE_INTEGER,
        }),
      },
    ];

    it.each(RICH_TICK_CORPUS)("$label", async ({ tick }) => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      const channel = `af:ticks:${tick.symbol}`;
      mockClientInstance._emit("pmessage", "af:ticks:*", channel, JSON.stringify(tick));

      expect(onTick).toHaveBeenCalledTimes(1);
      // Deep equality — every field in tick must survive JSON round-trip.
      const received = onTick.mock.calls[0][0] as LiveTick;
      expect(received).toEqual(tick);
    });
  });

  // ── Property 13c: channel suffix and tick.symbol are preserved ───────────
  //
  // The `symbol` field in the forwarded tick equals the symbol encoded in
  // the channel name (channel suffix after the final `:`). This is enforced
  // by constructing the JSON payload with matching symbol values and asserting
  // the parsed object's `symbol` field equals the channel suffix.
  //
  describe("13c — tick.symbol matches the channel suffix", () => {
    const CHANNEL_SYMBOL_PAIRS = [
      "NIFTY",
      "BANKNIFTY",
      "RELIANCE",
      "AAPL123",
      "INFY",
    ];

    it.each(CHANNEL_SYMBOL_PAIRS)("channel af:ticks:%s → tick.symbol = %s", async (symbol) => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      const tick = buildTick(symbol, 1000.0);
      const channel = `af:ticks:${symbol}`;
      const channelSuffix = channel.split(":").at(-1)!;

      mockClientInstance._emit("pmessage", "af:ticks:*", channel, JSON.stringify(tick));

      expect(onTick).toHaveBeenCalledTimes(1);
      const received = onTick.mock.calls[0][0] as LiveTick;
      // The forwarded tick's symbol field equals the channel suffix.
      expect(received.symbol).toBe(channelSuffix);
    });
  });

  // ── Property 13d: malformed JSON — onTick never called ───────────────────
  //
  // For any non-JSON-parseable message, the `onTick` callback SHALL NOT be
  // called. This is the converse of the main property — only valid (parseable)
  // messages are forwarded.
  //
  describe("13d — onTick NOT called for malformed JSON", () => {
    const MALFORMED_MESSAGES = [
      { label: "clearly invalid",         body: "not valid json{{{" },
      { label: "truncated JSON",          body: '{"symbol":"NIFTY","ltp":' },
      { label: "empty string",            body: "" },
      { label: "plain text",             body: "NIFTY 22500" },
      { label: "JSON with syntax error", body: "{'symbol':'NIFTY'}" }, // single quotes
    ];

    it.each(MALFORMED_MESSAGES)("$label → onTick never called", async ({ body }) => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      mockClientInstance._emit("pmessage", "af:ticks:*", "af:ticks:NIFTY", body);

      expect(onTick).not.toHaveBeenCalled();
      // Warn logged for the failed parse.
      expect(logWarn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Property 13e: multiple sequential messages all forwarded ─────────────
  //
  // When N valid messages arrive sequentially on different channels, `onTick`
  // SHALL be called exactly N times, once per message, in arrival order.
  //
  describe("13e — multiple sequential messages all forwarded in order", () => {
    it("3 messages on different symbols — onTick called 3 times with correct payloads", async () => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      const ticks = [
        buildTick("NIFTY",     22500.5),
        buildTick("BANKNIFTY", 48320.0),
        buildTick("RELIANCE",  2840.75),
      ];

      for (const tick of ticks) {
        mockClientInstance._emit(
          "pmessage",
          "af:ticks:*",
          `af:ticks:${tick.symbol}`,
          JSON.stringify(tick),
        );
      }

      expect(onTick).toHaveBeenCalledTimes(3);
      for (let i = 0; i < ticks.length; i++) {
        expect(onTick).toHaveBeenNthCalledWith(i + 1, ticks[i]);
      }
    });

    it("5 messages on the same symbol — onTick called 5 times with correct payloads", async () => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      const ltps = [22400, 22450, 22500, 22550, 22600];
      const ticks = ltps.map((ltp) => buildTick("NIFTY", ltp));

      for (const tick of ticks) {
        mockClientInstance._emit(
          "pmessage",
          "af:ticks:*",
          "af:ticks:NIFTY",
          JSON.stringify(tick),
        );
      }

      expect(onTick).toHaveBeenCalledTimes(5);
      ticks.forEach((tick, i) => {
        expect(onTick).toHaveBeenNthCalledWith(i + 1, tick);
      });
    });
  });

  // ── Property 13f: listener continues after a bad message ─────────────────
  //
  // A JSON parse error on one message SHALL NOT prevent subsequent valid
  // messages from being forwarded (fault isolation / graceful continue).
  //
  describe("13f — listener continues normally after a bad message", () => {
    it("valid → invalid → valid sequence: onTick called for both valid messages", async () => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      const firstTick  = buildTick("NIFTY",    22500.5);
      const secondTick = buildTick("RELIANCE",  2840.75);

      // First: valid
      mockClientInstance._emit(
        "pmessage",
        "af:ticks:*",
        "af:ticks:NIFTY",
        JSON.stringify(firstTick),
      );
      // Second: malformed
      mockClientInstance._emit(
        "pmessage",
        "af:ticks:*",
        "af:ticks:RELIANCE",
        "NOT JSON",
      );
      // Third: valid
      mockClientInstance._emit(
        "pmessage",
        "af:ticks:*",
        "af:ticks:RELIANCE",
        JSON.stringify(secondTick),
      );

      // Two valid ticks forwarded, one skipped.
      expect(onTick).toHaveBeenCalledTimes(2);
      expect(onTick).toHaveBeenNthCalledWith(1, firstTick);
      expect(onTick).toHaveBeenNthCalledWith(2, secondTick);

      // Exactly one warning for the bad message.
      expect(logWarn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Property 13g: varied JSON structures are forwarded as-is ─────────────
  //
  // The listener must not validate or filter the parsed JSON — it forwards
  // whatever the JSON.parse result is. This ensures Property 13 holds for
  // any JSON-parseable payload regardless of whether it conforms to LiveTick.
  //
  describe("13g — any JSON-parseable payload is forwarded unmodified (no schema validation)", () => {
    const ARBITRARY_JSON_CORPUS: Array<{ label: string; payload: unknown }> = [
      { label: "minimal object",           payload: { symbol: "X", ltp: 1 } },
      { label: "empty object",             payload: {} },
      { label: "deeply nested object",     payload: { a: { b: { c: 42 } } } },
      { label: "JSON array",               payload: [1, 2, 3] },
      { label: "JSON number",              payload: 42 },
      { label: "JSON boolean",             payload: true },
      { label: "JSON null",                payload: null },
      { label: "full LiveTick shape",      payload: buildTick("NIFTY", 22500) },
    ];

    it.each(ARBITRARY_JSON_CORPUS)("$label → onTick receives exact parse result", async ({ payload }) => {
      const { startScrapingTickListener } = await importListener();
      const onTick = vi.fn();
      startScrapingTickListener(onTick);

      mockClientInstance._emit(
        "pmessage",
        "af:ticks:*",
        "af:ticks:NIFTY",
        JSON.stringify(payload),
      );

      expect(onTick).toHaveBeenCalledTimes(1);
      // The argument passed to onTick must deeply equal the round-tripped value.
      expect(onTick).toHaveBeenCalledWith(JSON.parse(JSON.stringify(payload)));
    });
  });
});
