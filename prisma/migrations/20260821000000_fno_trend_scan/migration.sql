-- FnO Trend Scanner history. One frozen row per (tradeDate, scanType, symbol)
-- so the bullish and bearish scan results build a daily track record.
-- Live-tracking (lastPrice, pnlPct, status) refreshed intraday by the worker.

-- CreateTable
CREATE TABLE "FnoTrendScan" (
    "id" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "scanType" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "tp1" DOUBLE PRECISION NOT NULL,
    "tp2" DOUBLE PRECISION NOT NULL,
    "tp3" DOUBLE PRECISION NOT NULL,
    "atr" DOUBLE PRECISION NOT NULL,
    "adxVal" DOUBLE PRECISION NOT NULL,
    "rsiVal" DOUBLE PRECISION NOT NULL,
    "changePct" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastPrice" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "resolvedAt" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FnoTrendScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FnoTrendScan_tradeDate_scanType_symbol_key" ON "FnoTrendScan"("tradeDate", "scanType", "symbol");

-- CreateIndex
CREATE INDEX "FnoTrendScan_tradeDate_scanType_idx" ON "FnoTrendScan"("tradeDate", "scanType");

-- CreateIndex
CREATE INDEX "FnoTrendScan_symbol_tradeDate_idx" ON "FnoTrendScan"("symbol", "tradeDate");

-- CreateIndex
CREATE INDEX "FnoTrendScan_status_tradeDate_idx" ON "FnoTrendScan"("status", "tradeDate");
