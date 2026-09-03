-- AlterTable
ALTER TABLE "PaperTrade" ADD COLUMN     "dataConfidenceAtEntry" INTEGER,
ADD COLUMN     "dataIsFallback" BOOLEAN,
ADD COLUMN     "dataObservationId" TEXT,
ADD COLUMN     "dataProviderAtEntry" TEXT,
ADD COLUMN     "dataQualityAtEntry" TEXT,
ADD COLUMN     "featureVersion" TEXT,
ADD COLUMN     "observationEventTime" TEXT,
ADD COLUMN     "quoteAgeAtEntryMs" INTEGER,
ADD COLUMN     "signalId" TEXT;

-- CreateTable
CREATE TABLE "candle_bar" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "intervalStr" TEXT NOT NULL,
    "time" INTEGER NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oi" DOUBLE PRECISION,
    "oiChange" DOUBLE PRECISION,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candle_bar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_lifecycle_event" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_lifecycle_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "universe_coverage_snapshot" (
    "id" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "expectedInstruments" INTEGER NOT NULL,
    "availableInstruments" INTEGER NOT NULL,
    "scannedInstruments" INTEGER NOT NULL,
    "dataCompleteInstruments" INTEGER NOT NULL,
    "dataPartialInstruments" INTEGER NOT NULL,
    "dataMissingInstruments" INTEGER NOT NULL,
    "strategyEvaluatedInstruments" INTEGER NOT NULL,
    "paperEligibleInstruments" INTEGER NOT NULL,
    "excludedInstruments" INTEGER NOT NULL,
    "exclusionReasons" JSONB NOT NULL DEFAULT '[]',
    "coverageScore" DOUBLE PRECISION NOT NULL,
    "isValid" BOOLEAN NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "universe_coverage_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_cluster" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "opportunityLabel" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "opportunityStartMs" BIGINT NOT NULL,
    "direction" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "representativeSignalId" TEXT,
    "independentConfirmations" INTEGER NOT NULL DEFAULT 1,
    "clusterConfidence" DOUBLE PRECISION NOT NULL,
    "deduplicated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_intelligence_record" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "reportingBucket" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "instrumentCategory" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "riskReward" DOUBLE PRECISION NOT NULL,
    "atr" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "qualityVector" JSONB NOT NULL,
    "expectedValue" JSONB NOT NULL,
    "grade" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "regime" TEXT NOT NULL,
    "regimeFit" TEXT NOT NULL,
    "dataQuality" JSONB NOT NULL,
    "riskDecision" TEXT NOT NULL,
    "paperDecision" TEXT NOT NULL,
    "abstentionReason" TEXT,
    "lifecycleState" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "modelVersions" JSONB,
    "featureVersion" TEXT,
    "rationale" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extras" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_intelligence_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candle_bar_instrumentId_exchange_intervalStr_time_idx" ON "candle_bar"("instrumentId", "exchange", "intervalStr", "time");

-- CreateIndex
CREATE INDEX "candle_bar_confirmedAt_idx" ON "candle_bar"("confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "candle_bar_instrumentId_exchange_intervalStr_time_key" ON "candle_bar"("instrumentId", "exchange", "intervalStr", "time");

-- CreateIndex
CREATE INDEX "signal_lifecycle_event_signalId_occurredAt_idx" ON "signal_lifecycle_event"("signalId", "occurredAt");

-- CreateIndex
CREATE INDEX "signal_lifecycle_event_sessionDate_strategyId_idx" ON "signal_lifecycle_event"("sessionDate", "strategyId");

-- CreateIndex
CREATE INDEX "signal_lifecycle_event_toState_sessionDate_idx" ON "signal_lifecycle_event"("toState", "sessionDate");

-- CreateIndex
CREATE INDEX "universe_coverage_snapshot_sessionDate_idx" ON "universe_coverage_snapshot"("sessionDate");

-- CreateIndex
CREATE INDEX "universe_coverage_snapshot_capturedAt_idx" ON "universe_coverage_snapshot"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_cluster_clusterId_key" ON "opportunity_cluster"("clusterId");

-- CreateIndex
CREATE INDEX "opportunity_cluster_sessionDate_instrument_idx" ON "opportunity_cluster"("sessionDate", "instrument");

-- CreateIndex
CREATE INDEX "opportunity_cluster_correlationId_idx" ON "opportunity_cluster"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "signal_intelligence_record_signalId_key" ON "signal_intelligence_record"("signalId");

-- CreateIndex
CREATE INDEX "signal_intelligence_record_sessionDate_strategyId_idx" ON "signal_intelligence_record"("sessionDate", "strategyId");

-- CreateIndex
CREATE INDEX "signal_intelligence_record_signalId_idx" ON "signal_intelligence_record"("signalId");

-- CreateIndex
CREATE INDEX "signal_intelligence_record_instrument_sessionDate_idx" ON "signal_intelligence_record"("instrument", "sessionDate");

-- CreateIndex
CREATE INDEX "signal_intelligence_record_reportingBucket_sessionDate_idx" ON "signal_intelligence_record"("reportingBucket", "sessionDate");
