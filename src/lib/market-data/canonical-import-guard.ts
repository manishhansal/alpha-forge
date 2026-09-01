/**
 * Canonical Market Data Import Guard
 *
 * Documents the forbidden import policy enforced by the ESLint rule and the
 * test suite in tests/lib/market-data/canonical-import-guard.test.ts.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POLICY: No consumer outside approved provider modules may import:
 *
 *   • yahoo-finance2                          — use registry.getQuotes() / getHistoricalCandles()
 *   • @/services/india/yahoo (outside providers/) — use canonical service layer
 *   • @/services/india/nse  (outside providers/) — use registry.getOptionChain()
 *   • @/services/india/angelone (outside providers/) — use registry for data, broker factory for orders
 *
 * APPROVED MODULES (the only files that may import the above directly):
 *   src/lib/market-data/providers/yahoo.ts
 *   src/lib/market-data/providers/nse.ts
 *   src/lib/market-data/providers/angel-one.ts
 *   src/lib/market-data/providers/upstox.ts
 *   src/services/india/yahoo/index.ts        — legacy adapter implementation
 *   src/services/india/nse/index.ts          — legacy adapter implementation
 *   src/services/india/angelone/index.ts     — legacy adapter implementation
 *   src/services/india/websocket/gateway.ts  — injection pattern (DOCUMENTED EXCEPTION)
 *   src/services/india/broker/factory.ts     — broker factory abstraction
 *   src/services/india/resolve.ts            — selected-source resolver
 * ═══════════════════════════════════════════════════════════════════════
 *
 * All other consumers MUST route through:
 *   import { registry, bootstrapRegistry } from '@/lib/market-data/registry'
 *   import { getHistoricalCandles } from '@/lib/market-data/services/historical.service'
 *   import { getOptionChain } from '@/lib/market-data/services/option-chain.service'
 */

/** List of forbidden import patterns (outside approved modules). */
export const FORBIDDEN_IMPORTS = [
  "yahoo-finance2",
] as const;

/**
 * Files that are explicitly approved to import legacy adapters directly.
 * These are either the canonical provider wrappers themselves, or
 * legacy adapter implementations that ARE the canonical wrappers' backends.
 */
export const ALLOWLISTED_BYPASS_FILES = [
  "src/lib/market-data/providers/yahoo.ts",
  "src/lib/market-data/providers/nse.ts",
  "src/lib/market-data/providers/angel-one.ts",
  "src/lib/market-data/providers/upstox.ts",
  "src/services/india/yahoo/index.ts",
  "src/services/india/nse/index.ts",
  "src/services/india/angelone/index.ts",
  "src/services/india/angelone/smartstream.ts",
  "src/services/india/websocket/gateway.ts",
  "src/services/india/broker/factory.ts",
  "src/services/india/resolve.ts",
] as const;

/**
 * Check if a file path is an allowlisted bypass (permitted to use legacy adapters).
 */
export function isAllowlistedBypass(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return ALLOWLISTED_BYPASS_FILES.some((allowed) => normalized.endsWith(allowed));
}
