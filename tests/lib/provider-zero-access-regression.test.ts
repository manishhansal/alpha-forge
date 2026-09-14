// @vitest-environment node
/**
 * Provider Zero-Access Regression Guard
 *
 * Phase 36 — Permanent regression test proving:
 *   NO_MARKET_DATA_PROVIDER_ACCESS_FROM_ALPHAFORGE
 *
 * This test will FAIL if a future developer introduces direct market data
 * provider access from AlphaForge. It is a permanent guard.
 *
 * Prohibited providers (direct market data access):
 *   - Angel One / SmartAPI (market data only — execution credentials are allowed)
 *   - Upstox analytics (execution OAuth is allowed)
 *   - NSE direct feeds
 *   - BSE direct feeds
 *   - Yahoo Finance / yahoo-finance2
 *   - Binance direct WebSocket or REST (for market data)
 *   - Deribit direct (for market data)
 *   - Delta Exchange direct (for market data)
 *   - Jugaad / jugaad-data
 *   - OpenChart
 *   - Scrapling (Python service — should not be reimported)
 *
 * Allowed:
 *   - @/lib/data-service/client — canonical data entry point
 *   - @/services/india/angelone — execution/portfolio ONLY (not market data)
 *   - @/services/india/broker — order execution ONLY
 *   - Upstox OAuth routes — execution ONLY
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

// ─── File walker ─────────────────────────────────────────────────────────────

function walkFiles(dir: string, exts: string[] = [".ts", ".tsx"]): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".next" || entry.name === "coverage") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Source files (excluding node_modules, .next, test setup) ────────────────

const SOURCE_FILES = walkFiles(join(ROOT, "src")).filter(
  (f) => !f.includes("/node_modules/") && !f.includes("/.next/"),
);
const WORKER_FILES = walkFiles(join(ROOT, "worker")).filter(
  (f) => !f.includes("/node_modules/"),
);
const ALL_FILES = [...SOURCE_FILES, ...WORKER_FILES];

function readSource(path: string): string {
  return readFileSync(path, "utf-8");
}

function relPath(abs: string): string {
  return abs.replace(ROOT + "/", "");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns files that match the predicate.
 */
function filesMatching(files: string[], predicate: (content: string) => boolean): string[] {
  return files.filter((f) => predicate(readSource(f)));
}

// ─── Blocked package imports ──────────────────────────────────────────────────

const BLOCKED_PACKAGES = [
  "yahoo-finance2",
  "jugaad-data",
  "jugaad",
  "openchart",
  "scrapling",
  "@kriptohabar/jugaad",
  "nse-tools",
  "nsepy",
  "bse-api",
  "smartapi-javascript",
  "smartapi-node",
  "@angel-broking",
  "@upstox-developer",
  "kiteconnect",
];

describe("Provider Zero-Access Regression — Package Imports", () => {
  for (const pkg of BLOCKED_PACKAGES) {
    it(`NO import of '${pkg}' in source or worker`, () => {
      const pattern = new RegExp(`(from|require)\\s*['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
      const violators = filesMatching(ALL_FILES, (c) => pattern.test(c));
      expect(violators, `Found '${pkg}' in: ${violators.map(relPath).join(", ")}`).toHaveLength(0);
    });
  }
});

// ─── Blocked direct HTTP URLs ─────────────────────────────────────────────────

const BLOCKED_MARKET_DATA_URLS = [
  // Angel One SmartAPI market data endpoints
  "smartohlc.angelbroking.com",
  "apiconnect.angelbroking.com/rest/secure/angelbroking/market",
  "apiconnect.angelbroking.com/rest/secure/angelbroking/marketData",
  // Upstox market data (analytics API)
  "api.upstox.com/v2/historical-candle",
  "api.upstox.com/v2/market-quote",
  "api.upstox.com/v2/option/chain",
  // NSE direct
  "nseindia.com",
  "nsefeed.com",
  "nsetools",
  // BSE direct
  "bseindia.com",
  // Yahoo Finance
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "finance.yahoo.com/quote",
  // Binance market data (not execution)
  "api.binance.com/api/v3/klines",
  "api.binance.com/api/v3/ticker",
  "fapi.binance.com",  // futures market data
  "wss://stream.binance.com",
  "wss://fstream.binance.com",
  // Deribit market data
  "deribit.com/api/v2/public",
  "wss://www.deribit.com",
  // Delta Exchange market data
  "api.india.delta.exchange/v2/history",
  "api.india.delta.exchange/v2/products",
  "api.india.delta.exchange/v2/orderbook",
  // CoinGecko (now goes through data-service2.0)
  "pro-api.coingecko.com/api/v3",
  "api.coingecko.com/api/v3",
];

describe("Provider Zero-Access Regression — Direct HTTP URLs", () => {
  for (const url of BLOCKED_MARKET_DATA_URLS) {
    it(`NO direct fetch to '${url}' in source or worker`, () => {
      const violators = filesMatching(ALL_FILES, (c) => c.includes(url));
      expect(violators, `Found '${url}' in: ${violators.map(relPath).join(", ")}`).toHaveLength(0);
    });
  }
});

// ─── Canonical data path enforcement ─────────────────────────────────────────

describe("Provider Zero-Access Regression — Canonical Data Path", () => {
  it("data-service client exists at canonical path", () => {
    const clientPath = join(ROOT, "src/lib/data-service/client.ts");
    const exists = statSync(clientPath, { throwIfNoEntry: false })?.isFile() ?? false;
    expect(exists, "src/lib/data-service/client.ts must exist").toBe(true);
  });

  it("DataServiceUnavailableError is exported from types", () => {
    const typesPath = join(ROOT, "src/lib/data-service/types.ts");
    const content = readSource(typesPath);
    expect(content).toMatch(/export.*DataServiceUnavailableError/);
  });

  it("no ProviderRegistry in source or worker", () => {
    // Only block actual imports, not comments/docs referencing the old registry
    const pattern = /^import[^'"]*from\s*['"].*lib\/market-data\/registry/m;
    const violators = filesMatching(ALL_FILES, (c) => pattern.test(c));
    expect(violators, `Found ProviderRegistry import in: ${violators.map(relPath).join(", ")}`).toHaveLength(0);
  });

  it("no provider adapter directories exist", () => {
    const blockedDirs = [
      "src/lib/market-data/providers",
      "src/lib/market-data/services",
      "src/services/india/yahoo",
      "src/services/india/nse",
      "src/services/binance",
      "src/services/deribit",
    ];
    for (const dir of blockedDirs) {
      const full = join(ROOT, dir);
      const exists = statSync(full, { throwIfNoEntry: false })?.isDirectory() ?? false;
      expect(exists, `Blocked directory exists: ${dir}`).toBe(false);
    }
  });
});

// ─── ESLint boundary rule present ────────────────────────────────────────────

describe("Provider Zero-Access Regression — ESLint Boundary", () => {
  it("eslint.config.mjs contains no-restricted-imports for market data providers", () => {
    const config = readSource(join(ROOT, "eslint.config.mjs"));
    expect(config).toContain("no-restricted-imports");
    expect(config).toContain("yahoo-finance2");
    expect(config).toContain("ProviderRegistry was removed");
    expect(config).toContain("DataServiceClient");
  });
});
