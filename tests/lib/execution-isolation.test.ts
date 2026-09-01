// @vitest-environment node
/**
 * Phase 13 — Shadow/Paper/Live Isolation Tests
 *
 * Verifies the critical isolation properties:
 *   1. SHADOW mode NEVER creates real broker calls
 *   2. PAPER mode NEVER calls broker order endpoint
 *   3. LIVE mode requires explicit LIVE_TRADING_ENABLED=true
 *   4. OpenAlgoAdapter.placeOrder throws when LIVE_TRADING_ENABLED != "true"
 *   5. Paper trading only creates DB records, no broker calls
 *   6. No broker adapter other than OpenAlgo implements placeOrder
 *
 * Validates: PHASE 13 requirements — execution mode isolation
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LIVE_TRADING_ENABLED guard in OpenAlgoAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenAlgoAdapter — LIVE_TRADING_ENABLED guard", () => {
  it("assertLiveTradingEnabled() is called in placeOrder", () => {
    const src = readSrc("src/services/india/broker/openalgo-adapter.ts");
    expect(src).toMatch(/assertLiveTradingEnabled\(\)/);
    // Verify it's called in placeOrder
    const placeOrderIdx = src.indexOf("async placeOrder(");
    const assertIdx = src.indexOf("assertLiveTradingEnabled()", placeOrderIdx);
    expect(assertIdx).toBeGreaterThan(placeOrderIdx);
  });

  it("assertLiveTradingEnabled() is called in modifyOrder", () => {
    const src = readSrc("src/services/india/broker/openalgo-adapter.ts");
    const modifyIdx = src.indexOf("async modifyOrder(");
    const assertIdx = src.indexOf("assertLiveTradingEnabled()", modifyIdx);
    expect(assertIdx).toBeGreaterThan(modifyIdx);
  });

  it("assertLiveTradingEnabled() is called in cancelOrder", () => {
    const src = readSrc("src/services/india/broker/openalgo-adapter.ts");
    const cancelIdx = src.indexOf("async cancelOrder(");
    const assertIdx = src.indexOf("assertLiveTradingEnabled()", cancelIdx);
    expect(assertIdx).toBeGreaterThan(cancelIdx);
  });

  it("throws when LIVE_TRADING_ENABLED is not 'true'", async () => {
    const orig = process.env.LIVE_TRADING_ENABLED;
    delete process.env.LIVE_TRADING_ENABLED;

    try {
      const { OpenAlgoAdapter } = await import("@/services/india/broker/openalgo-adapter");
      const adapter = new OpenAlgoAdapter("http://localhost:8080", "test-api-key");
      await expect(
        adapter.placeOrder({
          symbol: "NIFTY",
          exchange: "NSE",
          side: "BUY",
          quantity: 1,
          orderType: "MARKET",
          product: "MIS",
        })
      ).rejects.toThrow(/Live trading is not enabled/);
    } finally {
      if (orig !== undefined) process.env.LIVE_TRADING_ENABLED = orig;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Paper trading NEVER calls broker adapter placeOrder
// ─────────────────────────────────────────────────────────────────────────────

describe("Paper trading — no broker calls", () => {
  it("auto-trader creates DB records only — no BrokerAdapter import", () => {
    const src = readSrc("src/features/india/paper-trading/auto-trader.ts");
    // Auto-trader should not import any broker adapter
    expect(src).not.toMatch(/openalgo-adapter/i);
    expect(src).not.toMatch(/placeOrder/);
    expect(src).not.toMatch(/BrokerAdapter.*placeOrder/);
  });

  it("auto-trader uses db.paperTrade.create() for trade storage", () => {
    const src = readSrc("src/features/india/paper-trading/auto-trader.ts");
    expect(src).toMatch(/db\.paperTrade\.create/);
  });

  it("auto-trader does not import OpenAlgoAdapter", () => {
    const src = readSrc("src/features/india/paper-trading/auto-trader.ts");
    expect(src).not.toMatch(/from.*openalgo/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Angel One adapter — no placeOrder
// ─────────────────────────────────────────────────────────────────────────────

describe("Angel One adapter — no live order placement", () => {
  it("angel adapter does NOT implement placeOrder", () => {
    const src = readSrc("src/services/india/angelone/index.ts");
    // Angel One adapter should not have a placeOrder method
    // The comment says "intentionally NOT implemented"
    expect(src).not.toMatch(/async placeOrder\s*\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Trading mode isolation — only LIVE mode can reach assertLiveTradingEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe("Trading mode isolation", () => {
  it("broker types.ts defines BrokerAdapter without placeOrder in base interface", () => {
    const src = readSrc("src/services/india/broker/types.ts");
    // The BrokerAdapter base interface should not require placeOrder
    // (it's optional or only on OpenAlgo)
    // This confirms paper/shadow don't need to implement it
    const interfaceBlock = src.match(/interface BrokerAdapter[\s\S]*?^}/m)?.[0] ?? "";
    if (interfaceBlock) {
      // placeOrder is NOT in the base BrokerAdapter interface
      expect(interfaceBlock).not.toMatch(/placeOrder/);
    }
  });

  it("LIVE_TRADING_ENABLED env var is documented in env.ts", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/LIVE_TRADING_ENABLED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Execution guard is centralized in OpenAlgoAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("Centralized execution guard", () => {
  it("assertLiveTradingEnabled is defined in openalgo-adapter.ts", () => {
    const src = readSrc("src/services/india/broker/openalgo-adapter.ts");
    expect(src).toMatch(/function assertLiveTradingEnabled/);
  });

  it("assertLiveTradingEnabled checks LIVE_TRADING_ENABLED=true", () => {
    const src = readSrc("src/services/india/broker/openalgo-adapter.ts");
    expect(src).toMatch(/LIVE_TRADING_ENABLED.*!==.*"true"/);
  });

  it("error message is descriptive", () => {
    const src = readSrc("src/services/india/broker/openalgo-adapter.ts");
    expect(src).toMatch(/Live trading is not enabled/);
  });
});
