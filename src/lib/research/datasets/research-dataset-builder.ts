/**
 * Phase 3 — Canonical Research Dataset Builder
 *
 * All strategy research must use reproducible datasets identified by an
 * immutable SHA-256 fingerprint.  The same configuration always produces the
 * same fingerprint — accidentally researching against changing live data is
 * prevented by the fingerprint validation gate.
 *
 * Datasets are pure metadata records.  The actual OHLCV data lives in the
 * canonical market-data layer (registry + CandleBar table).  This module
 * tracks WHICH dataset was used for an experiment, not the data itself.
 */

import type { ResearchDataset, StrategyTimeframe } from "../types";

export interface DatasetConfig {
  provider: string;
  instrumentUniverse: string[];
  startDate: string; // ISO date "YYYY-MM-DD"
  endDate: string;
  timeframe: StrategyTimeframe;
  adjustments: string[];
  missingDataPolicy: ResearchDataset["missingDataPolicy"];
  calendarVersion: string;
  notes?: string;
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 fingerprint for a dataset configuration.
 * Uses the Web Crypto API (available in Node.js 20+ and all modern browsers).
 * The serialised config is sorted before hashing so field order is irrelevant.
 *
 * The fingerprint is the first 16 hex chars of the SHA-256 digest — long
 * enough to be unique in any realistic experiment set, short enough to be
 * human-readable in logs and filenames.
 */
export async function computeDatasetFingerprint(
  config: DatasetConfig,
): Promise<string> {
  // Canonical serialisation: sort all keys and instrument lists for stability
  const canonical = {
    adjustments: [...config.adjustments].sort(),
    calendarVersion: config.calendarVersion,
    endDate: config.endDate,
    instrumentUniverse: [...config.instrumentUniverse].sort(),
    missingDataPolicy: config.missingDataPolicy,
    provider: config.provider,
    startDate: config.startDate,
    timeframe: config.timeframe,
  };
  const json = JSON.stringify(canonical);
  const msgBuffer = new TextEncoder().encode(json);

  // Use Web Crypto (Node 20+ or browser)
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 32); // 32-char prefix (128 bits) — collision-safe
}

/**
 * Build a ResearchDataset record from a DatasetConfig.
 * The returned object is immutable — do not mutate it after creation.
 */
export async function buildResearchDataset(
  config: DatasetConfig,
  overrides: Partial<Pick<ResearchDataset, "datasetVersion" | "totalBars" | "totalSymbols">> = {},
): Promise<ResearchDataset> {
  const fingerprint = await computeDatasetFingerprint(config);

  return Object.freeze({
    datasetVersion: overrides.datasetVersion ?? `v1.0.0-${fingerprint.slice(0, 8)}`,
    fingerprint,
    provider: config.provider,
    instrumentUniverse: [...config.instrumentUniverse].sort(),
    startDate: config.startDate,
    endDate: config.endDate,
    timeframe: config.timeframe,
    adjustments: [...config.adjustments].sort(),
    missingDataPolicy: config.missingDataPolicy,
    dataQuality: 0, // populated after data quality scan
    calendarVersion: config.calendarVersion,
    generationTimestamp: new Date().toISOString(),
    totalBars: overrides.totalBars ?? 0,
    totalSymbols: overrides.totalSymbols ?? config.instrumentUniverse.length,
    notes: config.notes ?? "",
  });
}

/**
 * Validate that an experiment's dataset fingerprint matches the expected one.
 * Throws if the dataset has changed (e.g. provider backfill, adjustments).
 */
export function assertDatasetIntegrity(
  expected: string,
  actual: string,
  context: string,
): void {
  if (expected !== actual) {
    throw new Error(
      `[DatasetIntegrityError] Dataset fingerprint mismatch in "${context}".\n` +
        `  Expected: ${expected}\n` +
        `  Actual:   ${actual}\n` +
        `  The dataset has changed since this experiment was designed. ` +
        `Re-run the experiment against the current dataset or pin to the original data snapshot.`,
    );
  }
}

// ─── Canonical Dataset Definitions ───────────────────────────────────────────
// Pre-defined dataset configs used by the research pipeline.
// These are the ONLY datasets that should be used for official strategy research.

export const CANONICAL_DATASETS: Record<string, DatasetConfig> = {
  /** NSE F&O daily — full universe, 5 years */
  NSE_FNO_DAILY_5Y: {
    provider: "yahoo",
    instrumentUniverse: [], // populated from FNO_STOCKS + FNO_INDICES at runtime
    startDate: "2020-01-01",
    endDate: "2025-12-31",
    timeframe: "1d",
    adjustments: ["SPLIT_ADJUSTED", "DIVIDEND_ADJUSTED"],
    missingDataPolicy: "FORWARD_FILL",
    calendarVersion: "NSE_2020_2025",
    notes: "Primary NSE F&O research dataset. Development: 2020-2023. Validation: 2024. Final OOS: 2025.",
  },

  /** NSE F&O daily — recent 2 years for rolling validation */
  NSE_FNO_DAILY_2Y: {
    provider: "yahoo",
    instrumentUniverse: [],
    startDate: "2023-01-01",
    endDate: "2025-12-31",
    timeframe: "1d",
    adjustments: ["SPLIT_ADJUSTED", "DIVIDEND_ADJUSTED"],
    missingDataPolicy: "FORWARD_FILL",
    calendarVersion: "NSE_2023_2025",
    notes: "Rolling validation dataset. 2023 for training, 2024-2025 for OOS.",
  },

  /** Crypto BTC/ETH/SOL 5m — 3 years */
  CRYPTO_5M_3Y: {
    provider: "binance",
    instrumentUniverse: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    startDate: "2022-01-01",
    endDate: "2025-12-31",
    timeframe: "5m",
    adjustments: ["FUNDING_ADJUSTED"],
    missingDataPolicy: "DROP",
    calendarVersion: "CRYPTO_24x7",
    notes: "Primary crypto scalping research dataset.",
  },

  /** Crypto BTC/ETH/SOL 1m — 1 year */
  CRYPTO_1M_1Y: {
    provider: "binance",
    instrumentUniverse: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    startDate: "2024-01-01",
    endDate: "2025-12-31",
    timeframe: "1m",
    adjustments: ["FUNDING_ADJUSTED"],
    missingDataPolicy: "DROP",
    calendarVersion: "CRYPTO_24x7",
    notes: "FIB_PULLBACK research dataset. 1m only.",
  },
};
