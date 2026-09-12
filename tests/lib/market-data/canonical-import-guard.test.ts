/**
 * Canonical Market Data Import Guard — Regression Tests
 *
 * V9 Architecture Enforcement (Data-Service Centralization):
 *
 * These tests scan all source files for forbidden import patterns that bypass
 * the MarketDataRegistry. The three forbidden patterns enforced are:
 *
 *   1. yahoo-finance2         — direct import outside approved provider modules
 *   2. @/services/india/yahoo — direct import outside approved files
 *   3. @/services/india/angelone — direct import for market DATA (not broker analytics)
 *
 * Test IDs from DATA_SERVICE_TEST_PLAN.md: AE-001 through AE-015.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import {
  isAllowlistedBypass,
  isYahooImportAllowed,
  isAngelBrokerAnalyticsException,
} from "@/lib/market-data/canonical-import-guard";

// ── File scanner ─────────────────────────────────────────────────────────────

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "coverage") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectSourceFiles(full, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const ROOT = join(process.cwd());
const SRC_FILES = collectSourceFiles(join(ROOT, "src"));
const WORKER_FILES = collectSourceFiles(join(ROOT, "worker", "src"));
const ALL_FILES = [...SRC_FILES, ...WORKER_FILES];

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasDirectYahooFinance2Import(source: string): boolean {
  // Match: import ... from 'yahoo-finance2' or require('yahoo-finance2')
  return /from\s+['"]yahoo-finance2['"]|require\s*\(\s*['"]yahoo-finance2['"]\s*\)/.test(source);
}

function hasDirectYahooServiceImport(source: string): boolean {
  // Match: import { yahoo } from "@/services/india/yahoo" (static or dynamic)
  return (
    /from\s+['"]@\/services\/india\/yahoo['"]/.test(source) ||
    /import\s*\(\s*['"]@\/services\/india\/yahoo['"]\s*\)/.test(source)
  );
}

function hasDirectAngeloneMarketDataImport(source: string): boolean {
  // Match: import ... from "@/services/india/angelone" for market-data methods
  // (getHistorical, getQuotes, getOptionChain — not just isAngelConfigured or angel.getOiBuildup etc.)
  // We check for static and dynamic imports of the angelone module
  return (
    /from\s+['"]@\/services\/india\/angelone['"]/.test(source) ||
    /import\s*\(\s*['"]@\/services\/india\/angelone['"]\s*\)/.test(source)
  );
}

function relPath(absolute: string): string {
  return absolute.replace(ROOT + "/", "");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Canonical Market Data Import Guard", () => {
  // ── AE-001: yahoo-finance2 ────────────────────────────────────────────────
  it("AE-001: no non-allowlisted file directly imports yahoo-finance2", () => {
    const violations: string[] = [];

    for (const file of ALL_FILES) {
      if (isAllowlistedBypass(relPath(file))) continue;

      const source = readFileSync(file, "utf-8");
      if (hasDirectYahooFinance2Import(source)) {
        violations.push(relPath(file));
      }
    }

    if (violations.length > 0) {
      const report = violations.map((f) => `  • ${f}`).join("\n");
      throw new Error(
        `BYPASS VIOLATION: The following files import yahoo-finance2 directly.\n` +
          `They must route through the canonical MarketDataRegistry instead.\n\n` +
          `${report}\n\n` +
          `See: src/lib/market-data/canonical-import-guard.ts for approved modules.`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  // ── AE-002 through AE-008: @/services/india/yahoo outside allowlist ───────
  it("AE-002 through AE-008: no non-approved file imports @/services/india/yahoo directly", () => {
    const violations: string[] = [];

    for (const file of ALL_FILES) {
      const rel = relPath(file);
      // Skip if this file is in the yahoo-import allowlist
      if (isYahooImportAllowed(rel)) continue;
      // Also skip allowlisted bypass files (they cover the legacy adapter impls)
      if (isAllowlistedBypass(rel)) continue;

      const source = readFileSync(file, "utf-8");
      if (hasDirectYahooServiceImport(source)) {
        violations.push(rel);
      }
    }

    if (violations.length > 0) {
      const report = violations.map((f) => `  • ${f}`).join("\n");
      throw new Error(
        `BYPASS VIOLATION: The following files import @/services/india/yahoo directly.\n` +
          `They must route through registry.getQuotes() or registry.getHistoricalCandles().\n\n` +
          `${report}\n\n` +
          `Permitted files: see YAHOO_IMPORT_ALLOWLIST in canonical-import-guard.ts`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  // ── AE-009 through AE-015: @/services/india/angelone for market data ─────
  it("AE-009 through AE-013: no non-approved file imports @/services/india/angelone for market data", () => {
    const violations: string[] = [];

    for (const file of ALL_FILES) {
      const rel = relPath(file);
      // Skip approved broker-analytics exceptions and allowlisted adapter files
      if (isAngelBrokerAnalyticsException(rel)) continue;
      if (isAllowlistedBypass(rel)) continue;

      const source = readFileSync(file, "utf-8");
      if (hasDirectAngeloneMarketDataImport(source)) {
        violations.push(rel);
      }
    }

    if (violations.length > 0) {
      const report = violations.map((f) => `  • ${f}`).join("\n");
      throw new Error(
        `BYPASS VIOLATION: The following files import @/services/india/angelone directly.\n` +
          `Market-data calls must route through registry.getHistoricalCandles() /\n` +
          `registry.getOptionChain() etc.\n\n` +
          `${report}\n\n` +
          `Broker analytics (PCR/OI buildup) are documented exceptions — see\n` +
          `ANGEL_BROKER_ANALYTICS_EXCEPTIONS in canonical-import-guard.ts`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  // ── AE-012: ML service is clean ───────────────────────────────────────────
  it("AE-012: ML service has no direct broker provider imports", () => {
    // ML service is Python, not TypeScript — verified by absence of Python imports
    // in the TypeScript codebase. This test asserts no TypeScript ML bridge imports providers.
    const mlRelated = ALL_FILES.filter((f) => f.includes("ml-client") || f.includes("ml-service"));
    for (const file of mlRelated) {
      const source = readFileSync(file, "utf-8");
      expect(
        hasDirectYahooFinance2Import(source),
        `ML client file ${relPath(file)} must not import yahoo-finance2`,
      ).toBe(false);
      expect(
        hasDirectYahooServiceImport(source),
        `ML client file ${relPath(file)} must not import @/services/india/yahoo`,
      ).toBe(false);
    }
  });

  // ── AE-013: worker jobs don't import market-data providers directly ───────
  it("AE-013: worker jobs do not import market-data providers directly", () => {
    const workerJobFiles = WORKER_FILES.filter((f) => f.includes("/jobs/"));
    const violations: string[] = [];
    for (const file of workerJobFiles) {
      const rel = relPath(file);
      // india-realtime-candles is fixed (uses instrument-master.service)
      const source = readFileSync(file, "utf-8");
      if (hasDirectYahooFinance2Import(source)) violations.push(`${rel} (yahoo-finance2)`);
      if (hasDirectYahooServiceImport(source)) violations.push(`${rel} (@/services/india/yahoo)`);
    }
    if (violations.length > 0) {
      throw new Error(
        `Worker job bypass violations:\n${violations.map((v) => `  • ${v}`).join("\n")}\n` +
          `Worker jobs must route through the canonical service layer.`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  // ── Existing tests preserved ──────────────────────────────────────────────
  it("allowlisted provider files continue to compile (are present)", () => {
    const expectedProviderFiles = [
      "src/lib/market-data/providers/yahoo.ts",
      "src/lib/market-data/providers/nse.ts",
      "src/lib/market-data/providers/angel-one.ts",
      "src/services/india/yahoo/index.ts",
      "src/services/india/nse/index.ts",
      "src/services/india/angelone/index.ts",
    ];

    for (const rel of expectedProviderFiles) {
      const full = join(ROOT, rel);
      expect(
        existsSync(full),
        `Allowlisted provider file must exist: ${rel}`,
      ).toBe(true);
    }
  });

  it("top-picks route does not use yahoo-finance2 directly", () => {
    const file = join(ROOT, "src/app/api/in/top-picks/route.ts");
    const source = readFileSync(file, "utf-8");
    expect(
      hasDirectYahooFinance2Import(source),
      "top-picks route must not import yahoo-finance2 directly — use registry.getQuotes()",
    ).toBe(false);
  });

  it("sector-stocks route does not use yahoo-finance2 directly", () => {
    const file = join(ROOT, "src/app/api/in/sector-stocks/route.ts");
    const source = readFileSync(file, "utf-8");
    expect(
      hasDirectYahooFinance2Import(source),
      "sector-stocks route must not import yahoo-finance2 directly — use registry.getQuotes()",
    ).toBe(false);
  });

  it("top-picks route uses the canonical registry", () => {
    const file = join(ROOT, "src/app/api/in/top-picks/route.ts");
    const source = readFileSync(file, "utf-8");
    expect(
      source.includes("bootstrapRegistry") && source.includes("registry.getQuotes"),
      "top-picks route must call bootstrapRegistry() and registry.getQuotes()",
    ).toBe(true);
  });

  it("sector-stocks route uses the canonical registry", () => {
    const file = join(ROOT, "src/app/api/in/sector-stocks/route.ts");
    const source = readFileSync(file, "utf-8");
    expect(
      source.includes("bootstrapRegistry") && source.includes("registry.getQuotes"),
      "sector-stocks route must call bootstrapRegistry() and registry.getQuotes()",
    ).toBe(true);
  });

  // ── 3m eradication guard ──────────────────────────────────────────────────
  it("HD-020: no TypeScript file uses '3m' as a supported interval in production code", () => {
    // Only Binance-related files should have '3m'. Indian market code must not
    // register 3m as a supported/valid interval. Files that REJECT 3m are fine.
    const violations: string[] = [];
    const EXEMPT_PATTERNS = [
      "binance", "strategy-lab/run-backtest", "klines",
      "canonical-import-guard", // this guard file itself
    ];
    // These files use '3m' explicitly to BLOCK it — they are correct and exempt.
    const GUARD_FILES = [
      "provider-capability-matrix.ts",
      "provider-selection.ts",
      "candle-builder.service.ts",
      "v8-signal-data-gate.service.ts",
      "types.ts",
      "delta/rest.ts",                    // crypto broker (non-Indian)
      "historical-data/gaps/route.ts",    // data status API (lists removed timeframe)
      "historical-data/reconciliation/route.ts",
      "historical-data/status/route.ts",
      "DataStatusDashboard.tsx",          // UI shows "removed" label
    ];
    for (const file of ALL_FILES) {
      const rel = relPath(file);
      if (EXEMPT_PATTERNS.some((e) => file.includes(e))) continue;
      if (GUARD_FILES.some((g) => rel.includes(g))) continue;
      const source = readFileSync(file, "utf-8");
      // Only flag if '3m' appears as an interval VALUE being passed/used (not commented/rejected)
      // Look for: interval: "3m", "3m" in an array, switch case "3m"
      const nonCommentLines = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"));
      const has3mAsValue = nonCommentLines.some(
        (line) =>
          /interval[:\s=]+["'`]3m["'`]/.test(line) ||
          /\["3m"\]|"3m"\s*[:,]|case\s+"3m"/.test(line),
      );
      if (has3mAsValue) violations.push(rel);
    }
    if (violations.length > 0) {
      throw new Error(
        `3m interval used as a supported value in production TypeScript:\n` +
          `${violations.map((f) => `  • ${f}`).join("\n")}\n` +
          `3m was permanently removed in V8. Use 1m, 5m, 10m, 15m, 30m, 1h, 1d, 1w, or 1M.`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
