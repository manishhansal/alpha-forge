-- Data Foundation V5 — durable strike-level option snapshot (additive, new table).
CREATE TABLE IF NOT EXISTS "option_chain_strike" (
    "id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "strike" DOUBLE PRECISION NOT NULL,
    "optionType" TEXT NOT NULL,
    "ltp" DOUBLE PRECISION,
    "bid" DOUBLE PRECISION,
    "ask" DOUBLE PRECISION,
    "volume" DOUBLE PRECISION,
    "oi" DOUBLE PRECISION,
    "oiChange" DOUBLE PRECISION,
    "iv" DOUBLE PRECISION,
    "bidUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "askUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "ivUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "volumeUnavailable" BOOLEAN NOT NULL DEFAULT false,
    "captureTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "datasetVersion" TEXT,
    CONSTRAINT "option_chain_strike_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "option_chain_strike_unique"
    ON "option_chain_strike" ("underlying", "expiry", "strike", "optionType", "captureTimestamp", "provider");
CREATE INDEX IF NOT EXISTS "option_chain_strike_underlying_expiry_capture_idx"
    ON "option_chain_strike" ("underlying", "expiry", "captureTimestamp");
CREATE INDEX IF NOT EXISTS "option_chain_strike_underlying_capture_idx"
    ON "option_chain_strike" ("underlying", "captureTimestamp");
