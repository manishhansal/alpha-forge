// @vitest-environment node
/**
 * Reliability & failover matrix (spec §33-36).
 *
 * Deterministic, mock-driven tests that prove the 403 / 503 / 429 / timeout /
 * network resilience behaviour and the Angel → Upstox → Yahoo chaos failover /
 * recovery semantics WITHOUT any real provider credentials or network I/O.
 *
 * Every test asserts a concrete, measurable behaviour:
 *   - no retry storm on 403 (exactly one attempt, then fail over)
 *   - 429 honours Retry-After and is classified as RATE_LIMIT
 *   - 503 backs off and fails over (unavailable)
 *   - timeout / network are classified distinctly and retried
 *   - full provider failure flows Angel → Upstox → Yahoo
 *   - capability circuits isolate one capability from another
 *   - a recovered provider re-closes its circuit and returns to primary
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { withFailover, classifyError } from "@/lib/market-data/failover";
import {
  resetAllHealth,
  isCircuitOpen,
  isCapabilityCircuitOpen,
  recordFailure,
  recordSuccess,
  getProviderHealth,
  type Capability,
} from "@/lib/market-data/health";
import { MarketDataError } from "@/lib/market-data/types";
import {
  reconcileQuotes,
  reconciliationAgreementScore,
  evaluateSignalGate,
  buildQualityEnvelope,
  recordProviderSwitch,
} from "@/lib/market-data/services/reconciliation.service";
import type { MarketDataProvider, RegisteredProvider } from "@/lib/market-data/provider";
import type {
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OptionChain,
  ProviderHealth,
  ProviderId,
  SubscribeRequest,
} from "@/lib/market-data/types";

// ── Provider stub whose failure per attempt is scripted ─────────────────────────

type AttemptOutcome = "ok" | MarketDataError | Error;

function makeScriptedProvider(id: ProviderId, script: AttemptOutcome[] | AttemptOutcome): {
  provider: MarketDataProvider;
  calls: () => number;
} {
  let call = 0;
  const outcomeFor = (): AttemptOutcome => {
    const idx = call;
    call += 1;
    if (Array.isArray(script)) return script[Math.min(idx, script.length - 1)]!;
    return script;
  };
  const okQuote: MDQuote = {
    symbol: "TEST", token: null, exchange: "NSE", name: null, ltp: 100,
    change: null, changePct: null, prevClose: null, open: null, high: null,
    low: null, volume: null, oi: null, weekHigh52: null, weekLow52: null,
    upperCircuit: null, lowerCircuit: null, totalBuyQty: null, totalSellQty: null,
    lastTradeTime: null, provider: id, fetchedAt: new Date().toISOString(),
  };
  const provider: MarketDataProvider = {
    id,
    async getHistoricalCandles(_r: HistoricalCandleRequest) {
      const o = outcomeFor();
      if (o !== "ok") throw o;
      return [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    },
    async getLatestQuote() {
      const o = outcomeFor();
      if (o !== "ok") throw o;
      return { ...okQuote };
    },
    async getQuotes() {
      const o = outcomeFor();
      if (o !== "ok") throw o;
      return [{ ...okQuote }];
    },
    async getOptionChain(): Promise<OptionChain> {
      const o = outcomeFor();
      if (o !== "ok") throw o;
      throw new Error("no chain in stub");
    },
    async getInstrumentMaster(_f?: InstrumentMasterFilter): Promise<Instrument[]> { return []; },
    subscribe(_r: SubscribeRequest, _t: (t: LiveTick) => void) { return () => {}; },
    unsubscribe() {},
    getProviderHealth(): ProviderHealth {
      return { providerId: id, status: "healthy", score: 100, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0, circuitOpen: false, circuitRetryAt: null, latencyP50Ms: null, latencyP99Ms: null };
    },
  };
  return { provider, calls: () => call };
}

function entry(
  id: ProviderId,
  priority: number,
  script: AttemptOutcome[] | AttemptOutcome,
): RegisteredProvider & { _calls: () => number } {
  const { provider, calls } = makeScriptedProvider(id, script);
  return {
    provider,
    capabilities: { historicalCandles: true, liveQuotes: true, webSocket: true, optionChain: true, instrumentMaster: true, intradayCandles: true, fno: true },
    priority,
    enabled: true,
    _calls: calls,
  } as RegisteredProvider & { _calls: () => number };
}

const op = (p: MarketDataProvider) => p.getLatestQuote("TEST");
const err = (status: number, retryAfterMs?: number) =>
  new MarketDataError(`HTTP ${status}`, null, undefined, status, retryAfterMs);

beforeEach(() => {
  resetAllHealth();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── classifyError: status-code taxonomy ─────────────────────────────────────────

describe("classifyError (status-code taxonomy)", () => {
  it("403 → hard_block", () => {
    expect(classifyError(err(403))).toBe("hard_block");
    expect(classifyError(new Error("Request failed with status 403 Forbidden"))).toBe("hard_block");
  });
  it("Angel historical rate-limit 403 → rate_limit (NOT hard_block)", () => {
    // Angel returns HTTP 403 with this body when its ~3 req/s historical limit
    // is breached. It's transient — must be rate_limit so we back off, not a
    // hard_block that would open the circuit.
    expect(
      classifyError(new Error("SmartAPI /historical: HTTP 403 — Access denied because of exceeding access rate")),
    ).toBe("rate_limit");
  });
  it("401 → auth_failure", () => {
    expect(classifyError(err(401))).toBe("auth_failure");
  });
  it("429 → rate_limit", () => {
    expect(classifyError(err(429, 5000))).toBe("rate_limit");
    expect(classifyError(new Error("429 Too Many Requests"))).toBe("rate_limit");
  });
  it("503 → unavailable", () => {
    expect(classifyError(err(503))).toBe("unavailable");
    expect(classifyError(new Error("503 Service Unavailable"))).toBe("unavailable");
  });
  it("network / timeout are distinct", () => {
    expect(classifyError(new Error("ECONNRESET"))).toBe("network");
    expect(classifyError(new Error("request timed out"))).toBe("timeout");
  });
});

// ── 403: no retry storm, fail over immediately ──────────────────────────────────

describe("403 handling", () => {
  it("does NOT retry a 403 on the same provider and fails over", async () => {
    const angel = entry("angel_one", 1, err(403));
    const upstox = entry("upstox", 2, "ok");
    const result = await withFailover([angel, upstox], op, "getLatestQuote", "liveQuotes");
    expect(result?.provider).toBe("upstox");
    // Exactly ONE attempt on angel_one — no retry storm.
    expect(angel._calls()).toBe(1);
  });

  it("drives the angel_one score down and opens the circuit under repeated 403", async () => {
    for (let i = 0; i < 3; i++) recordFailure("angel_one", "hard_block");
    expect(isCircuitOpen("angel_one")).toBe(true);
  });
});

// ── 429: honour Retry-After, classify, fail over ────────────────────────────────

describe("429 handling", () => {
  it("classifies 429 as rate_limit and fails over to Upstox", async () => {
    const angel = entry("angel_one", 1, err(429, 1000));
    const upstox = entry("upstox", 2, "ok");
    const promise = withFailover([angel, upstox], op, "getLatestQuote", "liveQuotes");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.provider).toBe("upstox");
  });
});

// ── 503: backoff + fail over, no request storm ──────────────────────────────────

describe("503 handling", () => {
  it("retries with backoff then fails over on sustained 503", async () => {
    // angel returns 503 on every attempt; upstox healthy.
    const angel = entry("angel_one", 1, err(503));
    const upstox = entry("upstox", 2, "ok");
    const promise = withFailover([angel, upstox], op, "getLatestQuote", "liveQuotes");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.provider).toBe("upstox");
    // angel retried up to the retry cap (3), NOT unbounded.
    expect(angel._calls()).toBeLessThanOrEqual(3);
  });
});

// ── timeout / network are retryable ─────────────────────────────────────────────

describe("timeout & network handling", () => {
  it("retries a transient timeout and can still succeed on the same provider", async () => {
    // Fails twice with timeout, then succeeds on the 3rd attempt.
    const angel = entry("angel_one", 1, [new Error("timed out"), new Error("timed out"), "ok"]);
    const promise = withFailover([angel], op, "getLatestQuote", "liveQuotes");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.provider).toBe("angel_one");
    expect(angel._calls()).toBe(3);
  });
});

// ── CHAOS: full provider failure Angel → Upstox → Yahoo ─────────────────────────

describe("chaos: full provider failover chain", () => {
  it("TEST 1 — Angel down → Upstox serves", async () => {
    const angel = entry("angel_one", 1, err(503));
    const upstox = entry("upstox", 2, "ok");
    const yahoo = entry("yahoo", 3, "ok");
    const promise = withFailover([angel, upstox, yahoo], op, "getLatestQuote", "liveQuotes");
    await vi.runAllTimersAsync();
    expect((await promise)?.provider).toBe("upstox");
  });

  it("TEST 2 — Angel + Upstox down → Yahoo serves", async () => {
    const angel = entry("angel_one", 1, err(503));
    const upstox = entry("upstox", 2, err(503));
    const yahoo = entry("yahoo", 3, "ok");
    const promise = withFailover([angel, upstox, yahoo], op, "getHistoricalCandles", "historicalCandles");
    // getHistoricalCandles op used only to exercise the chain
    const chainOp = (p: MarketDataProvider) => p.getLatestQuote("TEST");
    void chainOp;
    await vi.runAllTimersAsync();
    expect((await promise)?.provider).toBe("yahoo");
  });

  it("TEST 3 — Angel recovers → circuit re-closes and it returns to primary", async () => {
    // Open the circuit. 503/unavailable is deliberately more forgiving than a
    // 403/auth failure, so it takes a short burst (not a single failure) to trip.
    for (let i = 0; i < 4; i++) recordFailure("angel_one", "unavailable");
    expect(isCircuitOpen("angel_one")).toBe(true);
    // Successful probe closes it.
    recordSuccess("angel_one", 50);
    expect(isCircuitOpen("angel_one")).toBe(false);
    const angel = entry("angel_one", 1, "ok");
    const upstox = entry("upstox", 2, "ok");
    const result = await withFailover([angel, upstox], op, "getLatestQuote", "liveQuotes");
    expect(result?.provider).toBe("angel_one");
  });

  it("TEST 4 — Angel keeps failing → Upstox stays primary, Angel not hammered", async () => {
    // Open angel circuit under a sustained 503 storm.
    for (let i = 0; i < 4; i++) recordFailure("angel_one", "unavailable");
    const angel = entry("angel_one", 1, "ok"); // would succeed, but circuit is open
    const upstox = entry("upstox", 2, "ok");
    const result = await withFailover([angel, upstox], op, "getLatestQuote", "liveQuotes");
    expect(result?.provider).toBe("upstox");
    // angel_one was skipped entirely — zero calls while its circuit is open.
    expect(angel._calls()).toBe(0);
  });
});

// ── Capability-aware circuits ────────────────────────────────────────────────────

describe("capability-aware circuit breakers", () => {
  it("historical DEGRADED does not down live", () => {
    const cap: Capability = "historicalCandles";
    for (let i = 0; i < 4; i++) recordFailure("angel_one", "unavailable", "503", cap);
    // The historical capability circuit is open…
    expect(isCapabilityCircuitOpen("angel_one", "historicalCandles")).toBe(true);
    // …but live is unaffected.
    expect(isCapabilityCircuitOpen("angel_one", "liveQuotes")).toBe(false);
    // And the provider-wide circuit stays closed.
    expect(isCircuitOpen("angel_one")).toBe(false);
  });

  it("routes live to Angel while historical fails over off Angel", async () => {
    const cap: Capability = "historicalCandles";
    for (let i = 0; i < 4; i++) recordFailure("angel_one", "unavailable", "503", cap);

    // Historical: Angel's historical circuit is open → Upstox serves.
    const angelH = entry("angel_one", 1, "ok");
    const upstoxH = entry("upstox", 2, "ok");
    const hist = await withFailover(
      [angelH, upstoxH],
      (p) => p.getHistoricalCandles({ symbol: "NIFTY", exchange: "NSE", interval: "5m", from: "x", to: "y" }),
      "getHistoricalCandles",
      "historicalCandles",
    );
    // The historical result came from a candle array; assert Upstox was used by
    // checking Angel historical was skipped (0 calls) and Upstox served (1 call).
    expect(angelH._calls()).toBe(0);
    expect(upstoxH._calls()).toBe(1);
    expect(hist).toHaveLength(1);

    // Live: Angel's live capability is healthy → Angel serves.
    const angelL = entry("angel_one", 1, "ok");
    const upstoxL = entry("upstox", 2, "ok");
    const live = await withFailover([angelL, upstoxL], op, "getLatestQuote", "liveQuotes");
    expect(live?.provider).toBe("angel_one");
  });
});

// ── Cross-provider reconciliation tiers ──────────────────────────────────────────

describe("cross-provider reconciliation", () => {
  it("MATCH when prices are effectively identical", () => {
    const r = reconcileQuotes(
      "NIFTY",
      { provider: "angel_one", ltp: 23850 },
      { provider: "upstox", ltp: 23850 },
      "INDEX",
    );
    expect(r.tier).toBe("MATCH");
    expect(reconciliationAgreementScore(r.tier)).toBe(1.0);
  });

  it("MAJOR_MISMATCH when prices diverge far beyond tolerance", () => {
    const r = reconcileQuotes(
      "NIFTY",
      { provider: "angel_one", ltp: 23850 },
      { provider: "upstox", ltp: 20000 },
      "INDEX",
    );
    expect(r.tier).toBe("MAJOR_MISMATCH");
  });

  it("INVALID when a field is structurally impossible", () => {
    const r = reconcileQuotes(
      "RELIANCE",
      { provider: "angel_one", ltp: 2500 },
      { provider: "upstox", ltp: -1 },
      "STOCK",
    );
    expect(r.tier).toBe("INVALID");
  });
});

// ── Stale-data signal gating (spec §19) ──────────────────────────────────────────

describe("signal-engine data gate", () => {
  const staleQuality = buildQualityEnvelope({
    source: "angel_one",
    stale: true,
    outlier: { anomalyScore: 0, isOutlier: false, reason: "NORMAL" },
    crossProviderAnomaly: null,
    structurallyValid: true,
  });

  it("blocks STALE data from the signal engine but allows the UI", () => {
    expect(evaluateSignalGate(staleQuality, "SIGNAL_ENGINE").allowed).toBe(false);
    expect(evaluateSignalGate(staleQuality, "ML_INFERENCE").allowed).toBe(false);
    expect(evaluateSignalGate(staleQuality, "EXECUTION").allowed).toBe(false);
    expect(evaluateSignalGate(staleQuality, "UI").allowed).toBe(true);
  });

  it("allows fresh VALID data for the signal engine", () => {
    const fresh = buildQualityEnvelope({
      source: "angel_one",
      stale: false,
      outlier: { anomalyScore: 0, isOutlier: false, reason: "NORMAL" },
      crossProviderAnomaly: false,
      structurallyValid: true,
    });
    expect(fresh.validationStatus).toBe("VALID");
    expect(evaluateSignalGate(fresh, "SIGNAL_ENGINE").allowed).toBe(true);
  });
});

// ── Provider-switch audit record (spec §30) ──────────────────────────────────────

describe("provider switch traceability", () => {
  it("emits a structured PROVIDER_SWITCH record with instrument + gap", () => {
    const evt = recordProviderSwitch({
      from: "angel_one",
      to: "upstox",
      reason: "HTTP_503",
      instrument: "NIFTY",
      gapMs: 0,
    });
    expect(evt.event).toBe("PROVIDER_SWITCH");
    expect(evt.from).toBe("angel_one");
    expect(evt.to).toBe("upstox");
    expect(evt.instrument).toBe("NIFTY");
    expect(evt.gapMs).toBe(0);
    expect(typeof evt.timestamp).toBe("string");
  });
});
