-- CreateEnum
CREATE TYPE "ScalpDirectionEnum" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "PaperTradeStatusEnum" AS ENUM ('OPEN', 'WIN', 'LOSS', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PaperTrade" (
    "id" TEXT NOT NULL,
    "symbol" "SymbolEnum" NOT NULL,
    "direction" "ScalpDirectionEnum" NOT NULL,
    "status" "PaperTradeStatusEnum" NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "rationale" TEXT[],
    "meta" JSONB NOT NULL,
    "notional" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "entry" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "riskReward" DOUBLE PRECISION NOT NULL,
    "atr" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "pnlUsd" DOUBLE PRECISION,
    "note" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaperTrade_symbol_openedAt_idx" ON "PaperTrade"("symbol", "openedAt");

-- CreateIndex
CREATE INDEX "PaperTrade_status_openedAt_idx" ON "PaperTrade"("status", "openedAt");

-- CreateIndex
CREATE INDEX "PaperTrade_source_openedAt_idx" ON "PaperTrade"("source", "openedAt");
