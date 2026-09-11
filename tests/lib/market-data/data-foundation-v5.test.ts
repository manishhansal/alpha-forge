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

  it("historical 5m equity → angel, upstox, yahoo (data-service EXCLUDED)", () => {
    const providers = selectProviders({ capability: "historicalCandles", interval: "5m", instrumentKind: "EQUITY", historical: true });
    expect(providers[0]).toBe("angel_one");
    expect(providers).toContain("upstox");
    expect(providers).not.toContain("scrapling");
  });

  it("historical 3m → upstox only (Angel has no 3m; Yahoo has no 3m intraday)", () => {
    const providers = selectProviders({ capability: "historicalCandles", interval: "3m", instrumentKind: "EQUITY", historical: true });
    expect(providers).toEqual(["upstox"]);
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

  it("historical interval support: Angel excludes 3m; Upstox includes it", () => {
    expect(providerSupportsHistoricalInterval("angel_one", "3m")).toBe(false);
    expect(providerSupportsHistoricalInterval("angel_one", "5m")).toBe(true);
    expect(providerSupportsHistoricalInterval("upstox", "3m")).toBe(true);
    expect(providerSupportsHistoricalInterval("scrapling", "5m")).toBe(false);
  });
});

// ── Upstox V3 interval mapping (§8) ────────────────────────────────────────

describe("intervalToUpstoxV3", () => {
  it("maps minute intervals to minutes/N (incl 3m, 5m, 15m, 30m)", () => {
    expect(intervalToUpstoxV3("1m")).toEqual({ unit: "minutes", value: 1 });
    expect(intervalToUpstoxV3("3m")).toEqual({ unit: "minutes", value: 3 });
    expect(intervalToUpstoxV3("5m")).toEqual({ unit: "minutes", value: 5 });
    expect(intervalToUpstoxV3("15m")).toEqual({ unit: "minutes", value: 15 });
    expect(intervalToUpstoxV3("30m")).toEqual({ unit: "minutes", value: 30 });
  });
  it("maps 1h→hours/1, 1d→days/1", () => {
    expect(intervalToUpstoxV3("1h")).toEqual({ unit: "hours", value: 1 });
    expect(intervalToUpstoxV3("1d")).toEqual({ unit: "days", value: 1 });
  });
});
