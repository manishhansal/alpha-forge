// @vitest-environment node
/**
 * Phase 2 — Market Data Wiring Audit Regression Tests
 *
 * Verifies that API routes that previously called yahoo-finance2 directly
 * now route through the canonical MarketDataRegistry / provider architecture.
 *
 * These are regression tests: they prove that:
 *   1. nifty-bias route uses registry.getLatestQuote, not direct YahooFinance
 *   2. No direct `yahoo-finance2` instantiation in route handlers
 *   3. snapshotter uses yahoo adapter (services/india/yahoo), not direct library
 *   4. vol-surface route uses fetchVolSurface from ml-client, not raw fetch
 *   5. portfolio-optimizer route uses predictPortfolioV2 from ml-client, not raw fetch
 *   6. option-chain route uses fetchOptionChainGreeks + predictIVRegime from ml-client
 *
 * Validates: PHASE 2 requirements — no direct provider bypasses
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helper: read source file
// ---------------------------------------------------------------------------
function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. nifty-bias route — no direct yahoo-finance2 import
// ─────────────────────────────────────────────────────────────────────────────

describe("nifty-bias route — provider architecture compliance", () => {
  it("does NOT import yahoo-finance2 directly", () => {
    const src = readSrc("src/app/api/in/nifty-bias/route.ts");
    // No direct import of yahoo-finance2 package
    expect(src).not.toMatch(/^import.*yahoo-finance2/m);
    expect(src).not.toMatch(/require\s*\(\s*['"]yahoo-finance2['"]\s*\)/);
    expect(src).not.toMatch(/new YahooFinance\s*\(\s*\)/);
  });

  it("routes through the canonical market-data registry", () => {
    const src = readSrc("src/app/api/in/nifty-bias/route.ts");
    // Must use the registry for data access
    expect(src).toMatch(/registry|bootstrapRegistry/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. snapshotter — no direct yahoo-finance2 import
// ─────────────────────────────────────────────────────────────────────────────

describe("signal snapshotter — provider architecture compliance", () => {
  it("does NOT import yahoo-finance2 directly", () => {
    const src = readSrc("src/services/india/signals/snapshotter.ts");
    expect(src).not.toContain("yahoo-finance2");
    expect(src).not.toContain("new YahooFinance");
    expect(src).not.toContain("yfClient");
  });

  it("uses the canonical yahoo service adapter", () => {
    const src = readSrc("src/services/india/signals/snapshotter.ts");
    expect(src).toMatch(/from.*@\/services\/india\/yahoo/);
    expect(src).toMatch(/yahoo\.getQuotes/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. vol-surface route — no raw ML service fetch
// ─────────────────────────────────────────────────────────────────────────────

describe("vol-surface route — ML client compliance", () => {
  it("does NOT contain raw fetch to ML_SERVICE_URL", () => {
    const src = readSrc("src/app/api/in/vol-surface/route.ts");
    // Should NOT have raw fetch with hard-coded or env-var ML URL
    expect(src).not.toMatch(/fetch\s*\(\s*`?\s*\$\{ML_SERVICE_URL\}/);
    expect(src).not.toMatch(/fetch\s*\(\s*['"`]http:\/\/localhost:8100/);
  });

  it("uses fetchVolSurface from ml-client", () => {
    const src = readSrc("src/app/api/in/vol-surface/route.ts");
    expect(src).toMatch(/from.*@\/lib\/india\/ml-client/);
    expect(src).toMatch(/fetchVolSurface/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. portfolio-optimizer route — no raw ML service fetch
// ─────────────────────────────────────────────────────────────────────────────

describe("portfolio-optimizer route — ML client compliance", () => {
  it("does NOT contain raw fetch to ML_SERVICE_URL", () => {
    const src = readSrc("src/app/api/in/portfolio-optimizer/route.ts");
    expect(src).not.toMatch(/fetch\s*\(\s*`?\s*\$\{ML_SERVICE_URL\}/);
    expect(src).not.toMatch(/ML_SERVICE_URL\s*=\s*process\.env/);
  });

  it("uses predictPortfolioV2 from ml-client", () => {
    const src = readSrc("src/app/api/in/portfolio-optimizer/route.ts");
    expect(src).toMatch(/from.*@\/lib\/india\/ml-client/);
    expect(src).toMatch(/predictPortfolioV2/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. option-chain route — no raw ML service fetch (greeks + iv-regime)
// ─────────────────────────────────────────────────────────────────────────────

describe("option-chain route — ML client compliance", () => {
  it("uses fetchOptionChainGreeks from ml-client (not raw fetch)", () => {
    const src = readSrc("src/app/api/in/option-chain/route.ts");
    expect(src).toMatch(/fetchOptionChainGreeks/);
    expect(src).toMatch(/from.*@\/lib\/india\/ml-client/);
  });

  it("uses predictIVRegime from ml-client (not raw fetch)", () => {
    const src = readSrc("src/app/api/in/option-chain/route.ts");
    expect(src).toMatch(/predictIVRegime/);
  });

  it("does NOT have bare fetch calls to analytics/greeks", () => {
    const src = readSrc("src/app/api/in/option-chain/route.ts");
    // raw fetch to ML greeks endpoint should be gone
    expect(src).not.toMatch(/fetch\s*\(\s*`\$\{ML_SERVICE_URL\}\/analytics\/greeks/);
  });

  it("does NOT have bare fetch calls to predict/iv-regime", () => {
    const src = readSrc("src/app/api/in/option-chain/route.ts");
    expect(src).not.toMatch(/fetch\s*\(\s*`\$\{ML_SERVICE_URL\}\/predict\/iv-regime/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ml-client — ML_MODE support
// ─────────────────────────────────────────────────────────────────────────────

describe("ml-client — ML_MODE env var support", () => {
  it("exports getMLMode()", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.getMLMode).toBe("function");
  });

  it("getMLMode returns 'fallback' by default", async () => {
    const { getMLMode } = await import("@/lib/india/ml-client");
    const orig = process.env.ML_MODE;
    delete process.env.ML_MODE;
    try {
      expect(getMLMode()).toBe("fallback");
    } finally {
      if (orig !== undefined) process.env.ML_MODE = orig;
    }
  });

  it("getMLMode returns 'disabled' when ML_MODE=disabled", async () => {
    const { getMLMode } = await import("@/lib/india/ml-client");
    const orig = process.env.ML_MODE;
    process.env.ML_MODE = "disabled";
    try {
      expect(getMLMode()).toBe("disabled");
    } finally {
      if (orig !== undefined) process.env.ML_MODE = orig;
      else delete process.env.ML_MODE;
    }
  });

  it("getMLMode returns 'required' when ML_MODE=required", async () => {
    const { getMLMode } = await import("@/lib/india/ml-client");
    const orig = process.env.ML_MODE;
    process.env.ML_MODE = "required";
    try {
      expect(getMLMode()).toBe("required");
    } finally {
      if (orig !== undefined) process.env.ML_MODE = orig;
      else delete process.env.ML_MODE;
    }
  });

  it("getMLMode falls back to 'fallback' for invalid values", async () => {
    const { getMLMode } = await import("@/lib/india/ml-client");
    const orig = process.env.ML_MODE;
    process.env.ML_MODE = "banana";
    try {
      expect(getMLMode()).toBe("fallback");
    } finally {
      if (orig !== undefined) process.env.ML_MODE = orig;
      else delete process.env.ML_MODE;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ml-enhanced-context — price forecast uses niftyLast60Bars (not empty array)
// ─────────────────────────────────────────────────────────────────────────────

describe("ml-enhanced-context — price forecast input wiring", () => {
  it("does NOT pass empty last_60_bars directly to mlFetch", () => {
    const src = readSrc("src/lib/india/ml-enhanced-context.ts");
    // The old hardcoded empty array bug should be gone
    expect(src).not.toMatch(/last_60_bars:\s*\[\]/);
  });

  it("uses predictPriceRegime from ml-client", () => {
    const src = readSrc("src/lib/india/ml-enhanced-context.ts");
    expect(src).toMatch(/predictPriceRegime/);
  });

  it("MLContextInputs includes niftyLast60Bars field", () => {
    const src = readSrc("src/lib/india/ml-enhanced-context.ts");
    expect(src).toMatch(/niftyLast60Bars/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ml-client — predictPriceRegime exported
// ─────────────────────────────────────────────────────────────────────────────

describe("ml-client — new analytics/utility functions exported", () => {
  it("exports predictPriceRegime", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.predictPriceRegime).toBe("function");
  });

  it("exports fetchOptionChainGreeks", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.fetchOptionChainGreeks).toBe("function");
  });

  it("exports predictIVRegime", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.predictIVRegime).toBe("function");
  });

  it("exports fetchVolSurface", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.fetchVolSurface).toBe("function");
  });

  it("exports predictPortfolioV2", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.predictPortfolioV2).toBe("function");
  });

  it("exports getMLModelsStatus", async () => {
    const mod = await import("@/lib/india/ml-client");
    expect(typeof mod.getMLModelsStatus).toBe("function");
  });
});
