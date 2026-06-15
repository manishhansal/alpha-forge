-- Daily Picks for the Indian F&O surface. One frozen row per
-- (tradeDate, bucket, rank). Entry / stop / target levels are frozen at
-- selection time; the live-tracking columns (status, lastPrice, pnlPct,
-- achievedPct) are refreshed as the underlying moves. Every past tradeDate
-- stays queryable so users can review old picks + their outcomes.

-- CreateTable
CREATE TABLE "IndiaDailyPick" (
    "id" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "winProbability" DOUBLE PRECISION NOT NULL,
    "underlyingPrice" DOUBLE PRECISION NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "canMoveUpto" DOUBLE PRECISION NOT NULL,
    "canExpectPct" DOUBLE PRECISION NOT NULL,
    "riskReward" DOUBLE PRECISION NOT NULL,
    "bucketScore" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT[],
    "logic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastPrice" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "achievedPct" DOUBLE PRECISION,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndiaDailyPick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IndiaDailyPick_tradeDate_bucket_rank_key" ON "IndiaDailyPick"("tradeDate", "bucket", "rank");

-- CreateIndex
CREATE INDEX "IndiaDailyPick_tradeDate_idx" ON "IndiaDailyPick"("tradeDate");

-- CreateIndex
CREATE INDEX "IndiaDailyPick_symbol_tradeDate_idx" ON "IndiaDailyPick"("symbol", "tradeDate");
