-- Periodic NSE option-chain analytics snapshots. NSE serves only the live
-- chain (no history endpoint), so the `india-oc-capture` worker persists a
-- row per underlying on a cadence during market hours. This is the history
-- the option-chain strategies (PCR / IV / OI build-up / Liquidity Edge /
-- Max-Pain Gravity) need to eventually become backtestable.

-- CreateTable
CREATE TABLE "OptionChainSnapshot" (
    "id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "spot" DOUBLE PRECISION,
    "changePct" DOUBLE PRECISION,
    "pcrOi" DOUBLE PRECISION,
    "pcrVolume" DOUBLE PRECISION,
    "maxPain" DOUBLE PRECISION,
    "atmIv" DOUBLE PRECISION,
    "maxCeOiStrike" DOUBLE PRECISION,
    "maxPeOiStrike" DOUBLE PRECISION,
    "totalCeOi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPeOi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCeOiChange" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPeOiChange" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "analytics" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptionChainSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OptionChainSnapshot_underlying_capturedAt_idx" ON "OptionChainSnapshot"("underlying", "capturedAt");

-- CreateIndex
CREATE INDEX "OptionChainSnapshot_capturedAt_idx" ON "OptionChainSnapshot"("capturedAt");
