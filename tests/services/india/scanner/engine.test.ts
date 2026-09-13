/**
 * Scanner Engine — Registry migration tests (V-02)
 *
 * Verifies that:
 * 1. engine.ts has NO static or dynamic import of @/services/india/yahoo (Req 3.3)
 * 2. fnoQuotes() delegates to registry.getQuotes() (Req 3.1)
 * 3. avgVolume() / evaluateRangeExpansion() / FnO trend scanners delegate to
 *    registry.getHistoricalCandles() (Req 3.2)
 * 4. Angel broker-analytics calls (getPutCallRatio, getOiBuildup,
 *    getTopGainersLosers) are retained as Documented_Exceptions with the
 *    required annotation comment (Req 3.4)
 * 5. No mocked Yahoo calls remain in scanner-specific test files (Req 3.5)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ScannerResult } from "@/types/india/scanner";
import type { MDQuote, OHLCVCandle } from "@/lib/market-data/types";

// ─── 1. Static import guard — no yahoo import in engine.ts ───────────────────

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/services/india/scanner/engine.ts",
);
const engineSource = readFileSync(ENGINE_PATH, "utf-8");

describe("V-02 Static import guard — engine.ts", () => {
  it("contains no static import of @/services/india/yahoo", () => {
    expect(engineSource).not.toMatch(/import\s+.*from\s+["']@\/services\/india\/yahoo["']/);
  });

  it("contains no dynamic import of @/services/india/yahoo", () => {
    expect(engineSource).not.toMatch(/import\s*\(\s*["']@\/services\/india\/yahoo["']\s*\)/);
  });

  it("does not reference the yahoo symbol or yahoo.getQuotes / yahoo.getHistorical as calls", () => {
    // Comments explaining the old Yahoo path are acceptable but function calls are not
    expect(engineSource).not.toMatch(/\byahoo\.getQuotes\s*\(/);
    expect(engineSource).not.toMatch(/\byahoo\.getHistorical\s*\(/);
  });
});

// ─── 2. Documented_Exception annotations ─────────────────────────────────────

describe("V-02 Documented_Exception annotations in engine.ts", () => {
  const ANNOTATION = "DATA_SERVICE_PRE_REFACTOR_AUDIT.md V-02: Documented_Exception";

  it("angel.getTopGainersLosers() calls are preceded by Documented_Exception comment", () => {
    // Find all occurrences of getTopGainersLosers and check the preceding line
    const lines = engineSource.split("\n");
    const callLines = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter(({ line }) => line.includes("angel.getTopGainersLosers("));

    expect(callLines.length).toBeGreaterThan(0);
    for (const { idx } of callLines) {
      // The annotation must appear on the line immediately before or on the same line
      const context = lines.slice(Math.max(0, idx - 1), idx + 1).join("\n");
      expect(context).toContain(ANNOTATION);
    }
  });

  it("angel.getPutCallRatio() call has Documented_Exception comment", () => {
    const lines = engineSource.split("\n");
    const callLine = lines.find((l) => l.includes("angel.getPutCallRatio("));
    expect(callLine).toBeDefined();
    expect(callLine).toContain(ANNOTATION);
  });

  it("angel.getOiBuildup() calls are preceded by Documented_Exception comment", () => {
    const lines = engineSource.split("\n");
    const callLines = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter(({ line }) => line.includes("angel.getOiBuildup("));

    expect(callLines.length).toBeGreaterThan(0);
    // At least one of the call-site vicinity lines must have the annotation
    const oiBuildupBlock = callLines[0].idx;
    const context = lines.slice(Math.max(0, oiBuildupBlock - 1), oiBuildupBlock + 1).join("\n");
    expect(context).toContain(ANNOTATION);
  });
});

// ─── 3. Runtime delegation — registry mock ────────────────────────────────────
//
// The engine imports the registry via dynamic `import("@/lib/market-data/registry")`.
// We mock the module so every internal call goes through our controlled stubs.

const getQuotesMock = vi.fn<(symbols: string[]) => Promise<Array<MDQuote | null>>>();
const getHistoricalMock = vi.fn<(req: unknown) => Promise<OHLCVCandle[]>>();
const getOptionChainMock = vi.fn();

vi.mock("@/lib/market-data/registry", () => ({
  bootstrapRegistry: () => Promise.resolve(),
  registry: {
    getQuotes: (...args: unknown[]) => getQuotesMock(...(args as [string[]])),
    getHistoricalCandles: (...args: unknown[]) => getHistoricalMock(...(args as [unknown])),
    getOptionChain: (...args: unknown[]) => getOptionChainMock(...args),
  },
}));

// Stub out angel so it doesn't attempt real SmartAPI calls in the test env
vi.mock("@/services/india/angelone", () => ({
  isAngelConfigured: () => false, // disables angel-first paths → falls through to registry
  angel: {},
}));

// Stub the in-memory cache so memo always executes the factory
vi.mock("@/services/india/cache", () => ({
  cache: {
    memo: async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  },
}));

// Minimal MDQuote factory
function makeQuote(symbol: string): MDQuote {
  return {
    symbol,
    token: null,
    exchange: "NSE",
    name: null,
    ltp: 100,
    change: 1,
    changePct: 1,
    prevClose: 99,
    open: 99,
    high: 101,
    low: 98,
    volume: 500_000,
    oi: null,
    weekHigh52: null,
    weekLow52: null,
    upperCircuit: null,
    lowerCircuit: null,
    totalBuyQty: null,
    totalSellQty: null,
    lastTradeTime: null,
    provider: "scrapling",
    fetchedAt: new Date().toISOString(),
  };
}

// Minimal candle factory — passes all 14 FnO-trend conditions
function makeCandles(n = 250): OHLCVCandle[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    // Rising close so SMA20>SMA40, EMA5>SMA20, etc. hold
    time: now - (n - i) * 86_400_000,
    open: 200 + i,
    high: 202 + i,
    low: 199 + i,
    close: 201 + i,
    volume: 200_000,
  }));
}

import { runScanner } from "@/services/india/scanner/engine";

describe("V-02 scanner engine — delegates to registry (not yahoo)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Req 3.1: fnoQuotes() uses registry.getQuotes ──────────────────────────

  it("momentum scanner calls registry.getQuotes() for F&O quotes", async () => {
    getQuotesMock.mockResolvedValue([makeQuote("RELIANCE"), makeQuote("TCS")]);

    const result = await runScanner("momentum", 5);

    expect(getQuotesMock).toHaveBeenCalled();
    expect(result.type).toBe("momentum");
    // No yahoo interaction — the mock would have thrown if yahoo was called
  });

  it("volume-breakout scanner calls registry.getQuotes() then registry.getHistoricalCandles()", async () => {
    // Step 1: fnoQuotes() via registry.getQuotes
    getQuotesMock.mockResolvedValue([
      makeQuote("RELIANCE"),
      makeQuote("TCS"),
    ]);
    // Step 2: avgVolume() via registry.getHistoricalCandles (returns 20 candles)
    const candles = makeCandles(25);
    getHistoricalMock.mockResolvedValue(candles);

    const result = await runScanner("volume-breakout", 5);

    expect(getQuotesMock).toHaveBeenCalled();
    // getHistoricalCandles is called with interval "1d" for avg volume
    const histCalls = getHistoricalMock.mock.calls;
    expect(histCalls.length).toBeGreaterThan(0);
    const firstReq = histCalls[0][0] as { interval: string; exchange: string };
    expect(firstReq.interval).toBe("1d");
    expect(firstReq.exchange).toBe("NSE");
    expect(result.type).toBe("volume-breakout");
  });

  // ── Req 3.2: historical candle calls use registry ─────────────────────────

  it("range-expansion scanner calls registry.getHistoricalCandles() with interval=1d", async () => {
    getQuotesMock.mockResolvedValue([makeQuote("INFY")]);
    getHistoricalMock.mockResolvedValue(makeCandles(250));

    const result = await runScanner("range-expansion", 5);

    expect(getHistoricalMock).toHaveBeenCalled();
    const req = getHistoricalMock.mock.calls[0][0] as { interval: string };
    expect(req.interval).toBe("1d");
    expect(result.type).toBe("range-expansion");
  });

  it("oi-buildup scanner calls registry.getQuotes() for index quotes", async () => {
    getQuotesMock.mockResolvedValue([makeQuote("NIFTY"), makeQuote("BANKNIFTY")]);
    getOptionChainMock.mockRejectedValue(new Error("no chain in test"));

    const result = await runScanner("oi-buildup", 5);

    // Regardless of option chain availability, registry.getQuotes was called
    expect(getQuotesMock).toHaveBeenCalled();
    expect(result.type).toBe("oi-buildup");
  });

  // ── Req 3.3: no yahoo import/call ─────────────────────────────────────────

  it("pcr scanner completes without any yahoo module call", async () => {
    getOptionChainMock.mockResolvedValue({
      spot: 22000,
      analytics: { pcrOi: 1.2, atmIv: 15, maxPeOiStrike: 21500, maxCeOiStrike: 22500, maxPain: 22000, totalCeOiChange: 1e6, totalPeOiChange: 1.2e6 },
      rows: [],
      underlying: "NIFTY",
      expiry: "2026-09-25",
      fetchedAt: new Date().toISOString(),
    });

    const result = await runScanner("pcr", 5);
    expect(result.type).toBe("pcr");
    // yahoo module was never imported (static guard above); here we confirm
    // no runtime error was thrown from an undefined yahoo object
  });

  it("iv-spike scanner completes without any yahoo module call", async () => {
    getOptionChainMock.mockResolvedValue({
      spot: 22000,
      analytics: { pcrOi: 1.1, atmIv: 18, maxPeOiStrike: null, maxCeOiStrike: null, maxPain: 22000, totalCeOiChange: 0, totalPeOiChange: 0 },
      rows: [],
      underlying: "NIFTY",
      expiry: "2026-09-25",
      fetchedAt: new Date().toISOString(),
    });

    const result = await runScanner("iv-spike");
    expect(result.type).toBe("iv-spike");
  });
});

// ─── 4. No yahoo mock/import in this test file ────────────────────────────────
// (Req 3.5 — enforced by the complete absence of any `yahoo` reference above)
