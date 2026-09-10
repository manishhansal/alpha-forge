-- CreateTable
CREATE TABLE "india_prediction_record" (
    "signalId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "timestampMs" BIGINT NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stop" DOUBLE PRECISION NOT NULL,
    "targets" DOUBLE PRECISION[],
    "timeframe" TEXT NOT NULL,
    "regime" TEXT NOT NULL,
    "instrumentType" TEXT NOT NULL,
    "sector" TEXT,
    "signalQuality" DOUBLE PRECISION NOT NULL,
    "grade" TEXT NOT NULL,
    "rawConfidence" DOUBLE PRECISION NOT NULL,
    "calibratedProbability" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION NOT NULL,
    "modelContributions" JSONB NOT NULL,
    "qualityComponents" JSONB NOT NULL,
    "abstentionDecision" BOOLEAN NOT NULL,
    "featureSnapshot" JSONB NOT NULL,
    "derivativesSnapshot" JSONB NOT NULL,
    "marketContext" JSONB NOT NULL,
    "dataQuality" DOUBLE PRECISION NOT NULL,
    "liquidity" DOUBLE PRECISION NOT NULL,
    "costEstimate" DOUBLE PRECISION NOT NULL,
    "slippageEstimate" DOUBLE PRECISION NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "qualityEngineVersion" TEXT,
    "gradingEngineVersion" TEXT,
    "calibrationVersion" TEXT,
    "featureVersion" TEXT,
    "datasetVersion" TEXT,
    "provider" TEXT,
    "providerTimestampMs" BIGINT,
    "tradeDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "india_prediction_record_pkey" PRIMARY KEY ("signalId")
);

-- CreateTable
CREATE TABLE "india_resolution_record" (
    "signalId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "exit" DOUBLE PRECISION,
    "exitTimeMs" BIGINT,
    "returnPct" DOUBLE PRECISION,
    "returnR" DOUBLE PRECISION,
    "mfe" DOUBLE PRECISION NOT NULL,
    "mae" DOUBLE PRECISION NOT NULL,
    "holdingTimeMs" BIGINT,
    "targetReached" BOOLEAN NOT NULL,
    "stopReached" BOOLEAN NOT NULL,
    "costActual" DOUBLE PRECISION NOT NULL,
    "slippageActual" DOUBLE PRECISION NOT NULL,
    "netReturn" DOUBLE PRECISION,
    "regimeDuringTrade" TEXT NOT NULL,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAtMs" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "india_resolution_record_pkey" PRIMARY KEY ("signalId")
);

-- CreateIndex
CREATE INDEX "india_prediction_record_symbol_tradeDate_idx" ON "india_prediction_record"("symbol", "tradeDate");

-- CreateIndex
CREATE INDEX "india_prediction_record_strategy_tradeDate_idx" ON "india_prediction_record"("strategy", "tradeDate");

-- CreateIndex
CREATE INDEX "india_prediction_record_grade_tradeDate_idx" ON "india_prediction_record"("grade", "tradeDate");

-- CreateIndex
CREATE INDEX "india_resolution_record_outcome_resolvedAtMs_idx" ON "india_resolution_record"("outcome", "resolvedAtMs");

-- CreateIndex
CREATE INDEX "candle_bar_instrumentId_exchange_intervalStr_time_idx" ON "candle_bar"("instrumentId", "exchange", "intervalStr", "time");

-- AddForeignKey
ALTER TABLE "india_resolution_record" ADD CONSTRAINT "india_resolution_record_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "india_prediction_record"("signalId") ON DELETE CASCADE ON UPDATE CASCADE;

