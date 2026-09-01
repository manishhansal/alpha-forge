/**
 * Canonical Market Data Import Guard — Regression Tests
 *
 * Phase 2: Enforce canonical market data access.
 *
 * These tests scan the source files for forbidden import patterns that bypass
 * the MarketDataRegistry. Any new strategy/scanner/ML file that directly
 * imports yahoo-finance2 (outside approved adapter modules) will fail this
 * suite.
 *
 * Rules:
 *   - `yahoo-finance2` must NOT be imported outside approved provider modules.
 *   - The approved modules (ALLOWLISTED_BYPASS_FILES) are the only exception.
 *
 * This gives us an automated regression guard against new bypasses.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { isAllowlistedBypass } from "@/lib/market-data/canonical-import-guard";

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

function relPath(absolute: string): string {
  return absolute.replace(ROOT + "/", "");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Canonical Market Data Import Guard", () => {
  it("no non-allowlisted file directly imports yahoo-finance2", () => {
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

  it("allowlisted provider files continue to compile (are present)", () => {
    // Verify the approved provider files actually exist — prevents the allowlist
    // from containing stale entries that would give false confidence.
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
      let exists = false;
      try {
        statSync(full);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists, `Allowlisted provider file must exist: ${rel}`).toBe(true);
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
});
