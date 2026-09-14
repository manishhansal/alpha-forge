-- AlphaForge data-service2.0 Centralization Refactor
-- Phase 2: Drop all market-data tables from the AlphaForge database.
--
-- Market data (candles, option chains, gaps, quality records, provenance,
-- instrument masters, F&O universe) is now owned exclusively by data-service2.0.
-- These tables are no longer written or read by AlphaForge.
--
-- Drop order respects FK constraints:
--   Step 1: Drop FK-dependent children before parents.
--   Step 2: Drop remaining market-data tables.
--
-- Using IF EXISTS throughout so the migration is safe to run even if a
-- table was already partially removed in a prior manual cleanup.

-- ── Step 1: Drop FK-dependent child tables first ─────────────────────────────

-- FnoUniverseEntry references FnoUniverseSnapshot
DROP TABLE IF EXISTS "fno_universe_entry";

-- InstrumentMasterEntry references InstrumentMasterSnapshot
DROP TABLE IF EXISTS "instrument_master_entry";

-- OptionChainStrike has no FK parent in this schema but uses its own @@map
DROP TABLE IF EXISTS "option_chain_strike";

-- ── Step 2: Drop remaining market-data tables ─────────────────────────────────

DROP TABLE IF EXISTS "fno_universe_snapshot";
DROP TABLE IF EXISTS "instrument_master_snapshot";
DROP TABLE IF EXISTS "OptionChainSnapshot";
DROP TABLE IF EXISTS "candle_bar";
DROP TABLE IF EXISTS "data_gap";
DROP TABLE IF EXISTS "data_quality_incident";
DROP TABLE IF EXISTS "provider_observation";
DROP TABLE IF EXISTS "data_correction";
DROP TABLE IF EXISTS "realtime_historical_mismatch";
DROP TABLE IF EXISTS "data_provenance";
DROP TABLE IF EXISTS "data_reconciliation";
DROP TABLE IF EXISTS "data_quality_score";
DROP TABLE IF EXISTS "historical_backfill_job";
DROP TABLE IF EXISTS "raw_acquisition_record";
DROP TABLE IF EXISTS "universe_coverage_snapshot";
