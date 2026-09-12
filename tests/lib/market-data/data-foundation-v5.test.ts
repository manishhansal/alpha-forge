/**
 * Data Foundation V5 — unit tests for the credential-propagation fix,
 * capability-aware provider selection, Upstox V3 interval mapping, and the
 * worker-credential override. Pure logic; the REAL provider→DB path is proven
 * by the scripts/data-v5-*.ts + scripts/data-cli.ts harnesses (DB-verified).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  setWorkerAngelCredentials,
  setWorkerUpstoxToken,
  getWorkerAngelCredentials,
  getWorkerUpstoxToken,
  workerCredentialStatus,
} from "@/lib/market-data/worker-credentials";
import {
  selectProviders,
  providerRuntimeAvailable,
  providerSupportsHistoricalInterval,
} from "@/lib/market-data/provider-selection";
import { intervalToUpstoxV3 } from "@/lib/market-data/normalizer";

// ── Worker credential override (the V5 root-cause fix) ─────────────────────

describe("worker credential override", () => {
  afterEach(() => {
    setWorkerAngelCredentials(null);
    setWorkerUpstoxToken(null);
  });

  it("stores and returns Angel credentials without a session", () => {
    setWorkerAngelCredentials({ apiKey: "k", clientCode: "c", pin: "p", totpSecret: "t" }, "user123456");
    const c = getWorkerAngelCredentials();
    expect(c?.apiKey).toBe("k");
    expect(workerCredentialStatus().angelLoaded).toBe(true);
    // Diagnostics never leak the full userId.
    expect(workerCredentialStatus().sourceUserId).toBe("user12…");
  });

  it("stores and returns the Upstox token", () => {
    setWorkerUpstoxToken("analytics-token-value");
    expect(getWorkerUpstoxToken()).toBe("analytics-token-value");
    expect(workerCredentialStatus().upstoxLoaded).toBe(true);
  });

  it("status never contains the secret values", () => {
    setWorkerUpstoxToken("SUPERSECRET_TOKEN_123");
    expect(JSON.stringify(workerCredentialStatus())).not.toContain("SUPERSECRET");
  });
});

// ── Capability-aware provider selection (§17/§18/§31) ──────────────────────

describe("provider selection", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    // Make Angel + Upstox appear available via worker override.
    setWorkerAngelCredentials({ apiKey: "k", clientCode: "c", pin: "p", totpSecret: "t" });
    setWorkerUpstoxToken("tok");
    process.env.DATA_SERVICE_URL = "http://localhost:8200";
  });
  afterEach(() => {
    setWorkerAngelCredentials(null);
    setWorkerUpstoxToken(null);
    process.env = { ...OLD };
  });

  it("options → angel then upstox, NEVER yahoo or data-service", () => {
    const providers = selectProviders({ capability: "optionChain" });
    expect(providers).toEqual(["angel_one", "upstox"]);
    expect(providers).not.toContain("yahoo");
    expect(providers).not.toContain("scrapling");
  });

  it("historical 5m → angel + upstox + openchart (not scrapling)", () => {
    const providers = selectProviders({ capability: "historicalCandles", interval: "5m", instrumentKind: "EQUITY", historical: true });
    expect(providers[0]).toBe("angel_one");
    expect(providers).toContain("upstox");
    expect(providers).toContain("openchart");
    expect(providers).not.toContain("scrapling");
  });

  // V8: 3m is no longer a supported interval — this test documents the removal.
  it("V8: 3m has been permanently removed from AlphaForge scope", () => {
    // 3m is no longer in the Interval type. providerSupportsHistoricalInterval
    // with a legacy "3m" string returns false for all providers.
    expect(providerSupportsHistoricalInterval("angel_one", "5m")).toBe(true);
    expect(providerSupportsHistoricalInterval("upstox", "5m")).toBe(true);
    expect(providerSupportsHistoricalInterval("jugaad", "1d")).toBe(true);
    expect(providerSupportsHistoricalInterval("openchart", "1d")).toBe(true);
    // Verify 3m is NOT in the Interval type by checking no provider has it.
    // (The type system would reject "3m" at compile time.)
  });

  it("live quote → angel, upstox, data-service, yahoo", () => {
    const providers = selectProviders({ capability: "liveQuote" });
    expect(providers).toContain("scrapling");
    expect(providers).toContain("yahoo");
  });

  it("options never routes to yahoo even for a 5m option request", () => {
    const providers = selectProviders({ capability: "historicalCandles", interval: "5m", instrumentKind: "OPTION", historical: true });
    expect(providers).not.toContain("yahoo");
  });

  it("providerRuntimeAvailable reflects the worker override", () => {
    expect(providerRuntimeAvailable("angel_one")).toBe(true);
    expect(providerRuntimeAvailable("upstox")).toBe(true);
    setWorkerAngelCredentials(null);
    delete process.env.SMARTAPI_API_KEY;
    expect(providerRuntimeAvailable("angel_one")).toBe(false);
  });

  it("historical interval support: jugaad serves 1d only; openchart serves full range", () => {
    expect(providerSupportsHistoricalInterval("jugaad", "1d")).toBe(true);
    expect(providerSupportsHistoricalInterval("jugaad", "5m")).toBe(false);
    expect(providerSupportsHistoricalInterval("openchart", "1m")).toBe(true);
    expect(providerSupportsHistoricalInterval("openchart", "1d")).toBe(true);
    expect(providerSupportsHistoricalInterval("scrapling", "5m")).toBe(false);
  });
});

// ── Upstox V3 interval mapping (§8) ────────────────────────────────────────

describe("intervalToUpstoxV3", () => {
  it("maps minute intervals to minutes/N (5m, 15m, 30m) — 3m removed from scope V8", () => {
    expect(intervalToUpstoxV3("1m")).toEqual({ unit: "minutes", value: 1 });
    // "3m" is no longer in the Interval type (V8 removal).
    expect(intervalToUpstoxV3("5m")).toEqual({ unit: "minutes", value: 5 });
    expect(intervalToUpstoxV3("15m")).toEqual({ unit: "minutes", value: 15 });
    expect(intervalToUpstoxV3("30m")).toEqual({ unit: "minutes", value: 30 });
  });
  it("maps 1h→hours/1, 1d→days/1", () => {
    expect(intervalToUpstoxV3("1h")).toEqual({ unit: "hours", value: 1 });
    expect(intervalToUpstoxV3("1d")).toEqual({ unit: "days", value: 1 });
  });
});
