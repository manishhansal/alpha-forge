-- Data Foundation V8 — Historical Data Fabric + F&O Universe
-- Migration: 20260912020000_data_foundation_v8_historical_fabric
--
-- Adds:
--   data_provenance           — per-dataset provenance with auth status
--   data_reconciliation       — multi-source OHLCV comparison records
--   data_quality_score        — deterministic quality scores per dataset
--   historical_backfill_job   — resumable backfill job tracking
--   raw_acquisition_record    — raw landing zone before normalization
--   fno_universe_snapshot     — versioned F&O universe header
--   fno_universe_entry        — per-symbol F&O universe constituent
--
-- All tables are additive — no existing tables are modified.
-- 3m references: deliberately absent (V8 removal).

-- ---------------------------------------------------------------------------
-- data_provenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "data_provenance" (
    "id"                      TEXT NOT NULL,
    "datasetKey"              TEXT NOT NULL,
    "instrumentId"            TEXT NOT NULL,
    "exchange"                TEXT NOT NULL,
    "intervalStr"             TEXT NOT NULL,
    "sessionDate"             TEXT NOT NULL,
    "provider"                TEXT NOT NULL,
    "sourceType"              TEXT NOT NULL,
    "authenticated"           BOOLEAN NOT NULL DEFAULT false,
    "credentialIdentityHash"  TEXT,
    "fetchedAt"               TIMESTAMP(3) NOT NULL,
    "sourceTimestamp"         TIMESTAMP(3),
    "responseHash"            TEXT,
    "datasetVersion"          TEXT NOT NULL,
    "instrumentMasterVersion" TEXT,
    "parserVersion"           TEXT NOT NULL DEFAULT '1',
    "normalizationVersion"    TEXT NOT NULL DEFAULT '1',
    "validationVersion"       TEXT NOT NULL DEFAULT '1',
    "dataTrustStatus"         TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "rowCount"                INTEGER NOT NULL DEFAULT 0,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_provenance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "data_provenance_datasetKey_provider_fetchedAt_key"
    ON "data_provenance"("datasetKey", "provider", "fetchedAt");
CREATE INDEX IF NOT EXISTS "data_provenance_instrumentId_exchange_intervalStr_sessionDate_idx"
    ON "data_provenance"("instrumentId", "exchange", "intervalStr", "sessionDate");
CREATE INDEX IF NOT EXISTS "data_provenance_provider_dataTrustStatus_idx"
    ON "data_provenance"("provider", "dataTrustStatus");
CREATE INDEX IF NOT EXISTS "data_provenance_datasetVersion_idx"
    ON "data_provenance"("datasetVersion");

-- ---------------------------------------------------------------------------
-- data_reconciliation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "data_reconciliation" (
    "id"                   TEXT NOT NULL,
    "instrumentId"         TEXT NOT NULL,
    "exchange"             TEXT NOT NULL,
    "intervalStr"          TEXT NOT NULL,
    "time"                 INTEGER NOT NULL,
    "sessionDate"          TEXT NOT NULL,
    "providerA"            TEXT NOT NULL,
    "providerB"            TEXT NOT NULL,
    "openA"                DOUBLE PRECISION,
    "openB"                DOUBLE PRECISION,
    "highA"                DOUBLE PRECISION,
    "highB"                DOUBLE PRECISION,
    "lowA"                 DOUBLE PRECISION,
    "lowB"                 DOUBLE PRECISION,
    "closeA"               DOUBLE PRECISION,
    "closeB"               DOUBLE PRECISION,
    "volumeA"              DOUBLE PRECISION,
    "volumeB"              DOUBLE PRECISION,
    "oiA"                  DOUBLE PRECISION,
    "oiB"                  DOUBLE PRECISION,
    "maxOhlcDiff"          DOUBLE PRECISION,
    "reconciliationStatus" TEXT NOT NULL,
    "toleranceConfig"      JSONB,
    "reconciledAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_reconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "data_reconciliation_instrumentId_exchange_intervalStr_time_providerA_providerB_key"
    ON "data_reconciliation"("instrumentId", "exchange", "intervalStr", "time", "providerA", "providerB");
CREATE INDEX IF NOT EXISTS "data_reconciliation_instrumentId_exchange_intervalStr_time_idx"
    ON "data_reconciliation"("instrumentId", "exchange", "intervalStr", "time");
CREATE INDEX IF NOT EXISTS "data_reconciliation_reconciliationStatus_sessionDate_idx"
    ON "data_reconciliation"("reconciliationStatus", "sessionDate");
CREATE INDEX IF NOT EXISTS "data_reconciliation_reconciledAt_idx"
    ON "data_reconciliation"("reconciledAt");

-- ---------------------------------------------------------------------------
-- data_quality_score
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "data_quality_score" (
    "id"                  TEXT NOT NULL,
    "instrumentId"        TEXT NOT NULL,
    "exchange"            TEXT NOT NULL,
    "intervalStr"         TEXT NOT NULL,
    "sessionDate"         TEXT NOT NULL,
    "qualityScore"        DOUBLE PRECISION,
    "qualityStatus"       TEXT NOT NULL,
    "completenessScore"   DOUBLE PRECISION,
    "validityScore"       DOUBLE PRECISION,
    "freshnessScore"      DOUBLE PRECISION,
    "provenanceScore"     DOUBLE PRECISION,
    "reconciliationScore" DOUBLE PRECISION,
    "duplicateRate"       DOUBLE PRECISION,
    "gapRate"             DOUBLE PRECISION,
    "timestampIntegrity"  DOUBLE PRECISION,
    "providerHealth"      DOUBLE PRECISION,
    "reasons"             TEXT[] NOT NULL DEFAULT '{}',
    "criticalFailure"     BOOLEAN NOT NULL DEFAULT false,
    "criticalReason"      TEXT,
    "provider"            TEXT,
    "datasetVersion"      TEXT,
    "computedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_quality_score_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "data_quality_score_instrumentId_exchange_intervalStr_sessionDate_key"
    ON "data_quality_score"("instrumentId", "exchange", "intervalStr", "sessionDate");
CREATE INDEX IF NOT EXISTS "data_quality_score_qualityStatus_sessionDate_idx"
    ON "data_quality_score"("qualityStatus", "sessionDate");
CREATE INDEX IF NOT EXISTS "data_quality_score_instrumentId_exchange_intervalStr_idx"
    ON "data_quality_score"("instrumentId", "exchange", "intervalStr");
CREATE INDEX IF NOT EXISTS "data_quality_score_computedAt_idx"
    ON "data_quality_score"("computedAt");

-- ---------------------------------------------------------------------------
-- historical_backfill_job
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "historical_backfill_job" (
    "id"               TEXT NOT NULL,
    "jobKey"           TEXT NOT NULL,
    "universeVersion"  TEXT,
    "provider"         TEXT NOT NULL,
    "instrumentId"     TEXT NOT NULL,
    "exchange"         TEXT NOT NULL,
    "intervalStr"      TEXT NOT NULL,
    "fromDate"         TEXT NOT NULL,
    "toDate"           TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'PENDING',
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "rowsFetched"      INTEGER NOT NULL DEFAULT 0,
    "rowsPersisted"    INTEGER NOT NULL DEFAULT 0,
    "rowsInvalid"      INTEGER NOT NULL DEFAULT 0,
    "rowsDuplicate"    INTEGER NOT NULL DEFAULT 0,
    "checksum"         TEXT,
    "checkpointDate"   TEXT,
    "failureReason"    TEXT,
    "startedAt"        TIMESTAMP(3),
    "completedAt"      TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_backfill_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "historical_backfill_job_jobKey_key"
    ON "historical_backfill_job"("jobKey");
CREATE INDEX IF NOT EXISTS "historical_backfill_job_status_provider_idx"
    ON "historical_backfill_job"("status", "provider");
CREATE INDEX IF NOT EXISTS "historical_backfill_job_instrumentId_exchange_intervalStr_idx"
    ON "historical_backfill_job"("instrumentId", "exchange", "intervalStr");
CREATE INDEX IF NOT EXISTS "historical_backfill_job_universeVersion_idx"
    ON "historical_backfill_job"("universeVersion");

-- ---------------------------------------------------------------------------
-- raw_acquisition_record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "raw_acquisition_record" (
    "id"              TEXT NOT NULL,
    "requestId"       TEXT NOT NULL,
    "provider"        TEXT NOT NULL,
    "endpoint"        TEXT NOT NULL,
    "instrumentId"    TEXT NOT NULL,
    "exchange"        TEXT NOT NULL,
    "intervalStr"     TEXT NOT NULL,
    "requestParams"   JSONB NOT NULL,
    "requestedAt"     TIMESTAMP(3) NOT NULL,
    "respondedAt"     TIMESTAMP(3) NOT NULL,
    "httpStatus"      INTEGER,
    "responseHash"    TEXT NOT NULL,
    "rawResponseJson" JSONB,
    "recordCount"     INTEGER NOT NULL DEFAULT 0,
    "parserVersion"   TEXT NOT NULL DEFAULT '1',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prunedAt"        TIMESTAMP(3),

    CONSTRAINT "raw_acquisition_record_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "raw_acquisition_record_requestId_key"
    ON "raw_acquisition_record"("requestId");
CREATE INDEX IF NOT EXISTS "raw_acquisition_record_provider_instrumentId_requestedAt_idx"
    ON "raw_acquisition_record"("provider", "instrumentId", "requestedAt");
CREATE INDEX IF NOT EXISTS "raw_acquisition_record_requestId_idx"
    ON "raw_acquisition_record"("requestId");
CREATE INDEX IF NOT EXISTS "raw_acquisition_record_responseHash_idx"
    ON "raw_acquisition_record"("responseHash");
CREATE INDEX IF NOT EXISTS "raw_acquisition_record_createdAt_idx"
    ON "raw_acquisition_record"("createdAt");

-- ---------------------------------------------------------------------------
-- fno_universe_snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fno_universe_snapshot" (
    "id"               TEXT NOT NULL,
    "universeVersion"  TEXT NOT NULL,
    "generatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveFrom"    TEXT NOT NULL,
    "effectiveTo"      TEXT,
    "sourceProvider"   TEXT NOT NULL,
    "checksum"         TEXT NOT NULL,
    "constituentCount" INTEGER NOT NULL,
    "fnoEquityCount"   INTEGER NOT NULL DEFAULT 0,
    "fnoIndexCount"    INTEGER NOT NULL DEFAULT 0,
    "addedCount"       INTEGER NOT NULL DEFAULT 0,
    "removedCount"     INTEGER NOT NULL DEFAULT 0,
    "suspendedCount"   INTEGER NOT NULL DEFAULT 0,
    "unresolvedCount"  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fno_universe_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fno_universe_snapshot_universeVersion_key"
    ON "fno_universe_snapshot"("universeVersion");
CREATE INDEX IF NOT EXISTS "fno_universe_snapshot_generatedAt_idx"
    ON "fno_universe_snapshot"("generatedAt");
CREATE INDEX IF NOT EXISTS "fno_universe_snapshot_effectiveFrom_idx"
    ON "fno_universe_snapshot"("effectiveFrom");

-- ---------------------------------------------------------------------------
-- fno_universe_entry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fno_universe_entry" (
    "id"              TEXT NOT NULL,
    "snapshotId"      TEXT NOT NULL,
    "symbol"          TEXT NOT NULL,
    "exchange"        TEXT NOT NULL,
    "isin"            TEXT,
    "instrumentType"  TEXT NOT NULL,
    "angelToken"      TEXT,
    "angelSymbol"     TEXT,
    "upstoxKey"       TEXT,
    "upstoxSymbol"    TEXT,
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latestExpiry"    TEXT,
    "fnoEligible"     BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "fno_universe_entry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "fno_universe_entry"
    ADD CONSTRAINT "fno_universe_entry_snapshotId_fkey"
    FOREIGN KEY ("snapshotId")
    REFERENCES "fno_universe_snapshot"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "fno_universe_entry_snapshotId_idx"
    ON "fno_universe_entry"("snapshotId");
CREATE INDEX IF NOT EXISTS "fno_universe_entry_symbol_exchange_idx"
    ON "fno_universe_entry"("symbol", "exchange");
CREATE INDEX IF NOT EXISTS "fno_universe_entry_lifecycleStatus_idx"
    ON "fno_universe_entry"("lifecycleStatus");
