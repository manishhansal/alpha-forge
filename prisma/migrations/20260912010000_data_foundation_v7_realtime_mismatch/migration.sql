-- Data Foundation V7 §16 — realtime vs historical reconciliation (additive, new table).
CREATE TABLE IF NOT EXISTS "realtime_historical_mismatch" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "intervalStr" TEXT NOT NULL,
    "time" INTEGER NOT NULL,
    "realtimeClose" DOUBLE PRECISION NOT NULL,
    "historicalClose" DOUBLE PRECISION NOT NULL,
    "difference" DOUBLE PRECISION NOT NULL,
    "realtimeProvider" TEXT,
    "historicalProvider" TEXT,
    "resolution" TEXT NOT NULL DEFAULT 'RECORDED_ONLY',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "realtime_historical_mismatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "realtime_historical_mismatch_symbol_intervalStr_time_idx"
    ON "realtime_historical_mismatch" ("symbol", "intervalStr", "time");
CREATE INDEX IF NOT EXISTS "realtime_historical_mismatch_detectedAt_idx"
    ON "realtime_historical_mismatch" ("detectedAt");
