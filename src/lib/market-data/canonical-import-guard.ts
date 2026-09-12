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
 *   src/services/india/angelone/smartstream.ts — WS protocol layer (backend for angel-one.ts)
 *   src/services/india/websocket/gateway.ts  — injection pattern (DOCUMENTED EXCEPTION)
 *   src/services/india/broker/factory.ts     — broker factory abstraction
 *   src/services/india/resolve.ts            — selected-source resolver
 *
 * DOCUMENTED EXCEPTIONS (broker-specific analytics with no registry equivalent):
 *   src/features/india/expiry-trades/builder.ts  — angel.getOptionChain("SENSEX") for BFO chain
 *   src/features/india/daily-picks/builder.ts    — angel.getOiBuildup (SmartAPI-only analytics)
 *   src/features/ai-signals/india-builder.ts     — angel.getPutCallRatio / getOiBuildup
 *   src/services/india/scanner/engine.ts         — angel.getPutCallRatio/getOiBuildup/getTopGainersLosers
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
  "@/services/india/yahoo",
  // @/services/india/angelone is monitored separately (broker analytics are exceptions)
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
 * Files approved to import @/services/india/yahoo (after V9 migration all
 * consumer yahoo imports are replaced with registry calls — this list should
 * shrink to zero over time).
 */
export const YAHOO_IMPORT_ALLOWLIST: readonly string[] = [
  // adapter implementation files — approved permanent
  "src/lib/market-data/providers/yahoo.ts",
  "src/services/india/yahoo/index.ts",
] as const;

/**
 * Files with documented broker-analytics exceptions that may import
 * @/services/india/angelone directly for SmartAPI-specific endpoints
 * (PCR, OI buildup, gainers/losers) that have no registry equivalent,
 * OR for credential type imports only.
 */
export const ANGEL_BROKER_ANALYTICS_EXCEPTIONS: readonly string[] = [
  "src/services/india/angelone/index.ts",      // the adapter itself
  "src/lib/market-data/providers/angel-one.ts", // approved provider wrapper
  "src/services/india/websocket/gateway.ts",    // documented injection exception
  "src/services/india/broker/factory.ts",       // broker factory
  "src/services/india/resolve.ts",              // source resolver
  "src/features/india/expiry-trades/builder.ts",  // SENSEX BFO chain (no registry route for BSE)
  "src/features/india/daily-picks/builder.ts",     // angel.getOiBuildup (SmartAPI-only)
  "src/features/ai-signals/india-builder.ts",      // angel PCR/OI (SmartAPI-only)
  "src/services/india/scanner/engine.ts",           // angel PCR/OI/gainers (SmartAPI-only)
  "src/features/settings/angel-credentials.ts",     // type-only import (AngelCredentials)
  "src/app/api/in/health/route.ts",                  // isAngelConfigured status check only
  "src/app/api/in/portfolio/route.ts",               // broker portfolio (funds/holdings/positions)
  "src/app/api/in/feed/stream/route.ts",             // broker WebSocket SSE feed
] as const;

/**
 * Check if a file path is an allowlisted bypass (permitted to use legacy adapters).
 */
export function isAllowlistedBypass(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return ALLOWLISTED_BYPASS_FILES.some((allowed) => normalized.endsWith(allowed));
}

/**
 * Check if a file is approved to import @/services/india/yahoo directly.
 */
export function isYahooImportAllowed(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return YAHOO_IMPORT_ALLOWLIST.some((allowed) => normalized.endsWith(allowed));
}

/**
 * Check if a file is an approved angel-broker-analytics exception.
 */
export function isAngelBrokerAnalyticsException(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return ANGEL_BROKER_ANALYTICS_EXCEPTIONS.some((allowed) => normalized.endsWith(allowed));
}
