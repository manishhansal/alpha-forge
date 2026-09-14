// @vitest-environment node
/**
 * Database Schema Guard — Phase 37
 *
 * Ensures obsolete market-data tables do NOT reappear in the Prisma schema.
 * This is a permanent guard test.
 *
 * If a future developer adds a market-data table back into the schema,
 * this test will fail with a clear error message.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf-8");

// ─── Forbidden model names (market data tables) ───────────────────────────────

const FORBIDDEN_MODELS = [
  // OHLCV data
  "CandleBar",
  "candle_bar",
  // Option chain data
  "OptionChainSnapshot",
  "option_chain_snapshot",
  "OptionChainStrike",
  "option_chain_strike",
  // Data quality
  "DataGap",
  "data_gap",
  "DataQualityIncident",
  "data_quality_incident",
  "DataQualityScore",
  "data_quality_score",
  "DataCorrection",
  "data_correction",
  "DataReconciliation",
  "data_reconciliation",
  // Provider observation
  "ProviderObservation",
  "provider_observation",
  // Data provenance
  "DataProvenance",
  "data_provenance",
  // Historical fabric
  "RealtimeHistoricalMismatch",
  "realtime_historical_mismatch",
  "HistoricalBackfillJob",
  "historical_backfill_job",
  "RawAcquisitionRecord",
  "raw_acquisition_record",
  // Instrument master
  "InstrumentMasterSnapshot",
  "instrument_master_snapshot",
  "InstrumentMasterEntry",
  "instrument_master_entry",
  // F&O universe
  "FnoUniverseSnapshot",
  "fno_universe_snapshot",
  "FnoUniverseEntry",
  "fno_universe_entry",
  // Universe coverage
  "UniverseCoverageSnapshot",
  "universe_coverage_snapshot",
];

describe("Database Schema Guard — Market Data Tables Must Not Exist", () => {
  for (const modelName of FORBIDDEN_MODELS) {
    it(`schema must NOT contain model '${modelName}'`, () => {
      // Match both Prisma model declaration and @@map directives
      const hasModel = new RegExp(`^model\\s+${modelName}\\s*\\{`, "m").test(SCHEMA);
      const hasMap = new RegExp(`@@map\\("${modelName}"\\)`).test(SCHEMA);
      const hasMapSingle = new RegExp(`@@map\\('${modelName}'\\)`).test(SCHEMA);
      expect(
        hasModel || hasMap || hasMapSingle,
        `Forbidden market-data model '${modelName}' found in prisma/schema.prisma. ` +
        `Market data is owned by data-service2.0 — do NOT add market data tables to AlphaForge.`,
      ).toBe(false);
    });
  }
});

// ─── Verify canonical business tables still exist ────────────────────────────

const REQUIRED_MODELS = [
  "User",
  "UserSetting",
  "Alert",
  "Notification",
  "Strategy",
  "SignalHistory",
  "PaperTrade",
  "IndiaDailyPick",
  "SignalIntelligenceRecord",
  "SignalLifecycleEvent",
];

describe("Database Schema Guard — Required Business Tables Must Exist", () => {
  for (const modelName of REQUIRED_MODELS) {
    it(`schema must contain model '${modelName}'`, () => {
      const hasModel = new RegExp(`^model\\s+${modelName}\\s*\\{`, "m").test(SCHEMA);
      expect(hasModel, `Required business model '${modelName}' is missing from schema`).toBe(true);
    });
  }
});

// ─── Verify drop migration exists ────────────────────────────────────────────

describe("Database Schema Guard — Drop Migration Exists", () => {
  it("migration 20260914000000_drop_market_data_tables exists and drops candle_bar", () => {
    const migrationPath = join(
      ROOT,
      "prisma/migrations/20260914000000_drop_market_data_tables/migration.sql",
    );
    const migration = readFileSync(migrationPath, "utf-8");
    expect(migration).toContain('DROP TABLE IF EXISTS "candle_bar"');
    expect(migration).toContain('DROP TABLE IF EXISTS "OptionChainSnapshot"');
    expect(migration).toContain('DROP TABLE IF EXISTS "instrument_master_snapshot"');
  });
});
