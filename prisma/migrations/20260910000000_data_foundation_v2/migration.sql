-- Data Foundation V2 — additive, non-destructive migration.
-- Adds candle provenance columns (nullable / defaulted) and four new data-
-- reliability tables. NO existing column is dropped or altered destructively;
-- existing rows keep NULL provenance and volumeUnavailable=false.
--
-- REVIEW BEFORE APPLYING: run against a backup/staging first. Apply with
--   npx prisma migrate deploy      (production-safe, no reset)
-- Do NOT use `prisma migrate reset` (destructive).

-- ── CandleBar provenance (additive) ──────────────────────────────────────────
ALTER TABLE "candle_bar" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "candle_bar" ADD COLUMN IF NOT EXISTS "sourceTimestamp" TIMESTAMP(3);
ALTER TABLE "candle_bar" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);
ALTER TABLE "candle_bar" ADD COLUMN IF NOT EXISTS "datasetVersion" TEXT;
ALTER TABLE "candle_bar" ADD COLUMN IF NOT EXISTS "volumeUnavailable" BOOLEAN NOT NULL DEFAULT false;

-- ── DataGap ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "data_gap" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "intervalStr" TEXT NOT NULL,
    "gapStart" INTEGER NOT NULL,
    "gapEnd" INTEGER NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "expectedProvider" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "recoveredAt" TIMESTAMP(3),
    "recoveryProvider" TEXT,
    "reason" TEXT,
    "requestId" TEXT,
    "datasetVersion" TEXT,
    CONSTRAINT "data_gap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "data_gap_instrumentId_exchange_intervalStr_gapStart_key"
    ON "data_gap"("instrumentId", "exchange", "intervalStr", "gapStart");
CREATE INDEX IF NOT EXISTS "data_gap_recoveryStatus_idx" ON "data_gap"("recoveryStatus");
CREATE INDEX IF NOT EXISTS "data_gap_instrumentId_exchange_intervalStr_idx"
    ON "data_gap"("instrumentId", "exchange", "intervalStr");
CREATE INDEX IF NOT EXISTS "data_gap_detectedAt_idx" ON "data_gap"("detectedAt");

-- ── DataQualityIncident ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "data_quality_incident" (
    "id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "provider" TEXT,
    "instrumentId" TEXT,
    "intervalStr" TEXT,
    "failureType" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "rootCause" TEXT,
    "detail" JSONB,
    "requestId" TEXT,
    "affectedRecords" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "data_quality_incident_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "data_quality_incident_severity_status_idx" ON "data_quality_incident"("severity", "status");
CREATE INDEX IF NOT EXISTS "data_quality_incident_failureType_idx" ON "data_quality_incident"("failureType");
CREATE INDEX IF NOT EXISTS "data_quality_incident_detectedAt_idx" ON "data_quality_incident"("detectedAt");
CREATE INDEX IF NOT EXISTS "data_quality_incident_instrumentId_idx" ON "data_quality_incident"("instrumentId");

-- ── ProviderObservation ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "provider_observation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "requestId" TEXT,
    "sourceTimestamp" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadHash" TEXT,
    "rawPayload" JSONB,
    "schemaVersion" TEXT,
    "normalizationVersion" TEXT,
    CONSTRAINT "provider_observation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_observation_instrumentId_dataType_receivedAt_idx"
    ON "provider_observation"("instrumentId", "dataType", "receivedAt");
CREATE INDEX IF NOT EXISTS "provider_observation_provider_receivedAt_idx" ON "provider_observation"("provider", "receivedAt");
CREATE INDEX IF NOT EXISTS "provider_observation_payloadHash_idx" ON "provider_observation"("payloadHash");

-- ── DataCorrection ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "data_correction" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "intervalStr" TEXT NOT NULL,
    "time" INTEGER NOT NULL,
    "original" JSONB NOT NULL,
    "corrected" JSONB NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT,
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "requestId" TEXT,
    "datasetVersion" TEXT,
    CONSTRAINT "data_correction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "data_correction_instrumentId_exchange_intervalStr_time_idx"
    ON "data_correction"("instrumentId", "exchange", "intervalStr", "time");
CREATE INDEX IF NOT EXISTS "data_correction_correctedAt_idx" ON "data_correction"("correctedAt");
