-- CreateEnum
CREATE TYPE "StrategyBacktestPeriodEnum" AS ENUM ('WEEK_1', 'MONTH_1', 'MONTH_6', 'YEAR_1', 'YEAR_5');

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "symbols" "SymbolEnum"[],
    "liveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liveStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyBacktest" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT,
    "prompt" TEXT NOT NULL,
    "symbol" "SymbolEnum" NOT NULL,
    "period" "StrategyBacktestPeriodEnum" NOT NULL,
    "interval" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "equityCurve" JSONB NOT NULL,
    "trades" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyBacktest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyPaperTrade" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "symbol" "SymbolEnum" NOT NULL,
    "direction" "ScalpDirectionEnum" NOT NULL,
    "status" "PaperTradeStatusEnum" NOT NULL DEFAULT 'OPEN',
    "notional" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "entry" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "riskReward" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT[],
    "exitPrice" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "pnlUsd" DOUBLE PRECISION,
    "closeReason" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "StrategyPaperTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Strategy_userId_updatedAt_idx" ON "Strategy"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Strategy_liveEnabled_idx" ON "Strategy"("liveEnabled");

-- CreateIndex
CREATE INDEX "StrategyBacktest_strategyId_generatedAt_idx" ON "StrategyBacktest"("strategyId", "generatedAt");

-- CreateIndex
CREATE INDEX "StrategyBacktest_symbol_period_generatedAt_idx" ON "StrategyBacktest"("symbol", "period", "generatedAt");

-- CreateIndex
CREATE INDEX "StrategyPaperTrade_strategyId_openedAt_idx" ON "StrategyPaperTrade"("strategyId", "openedAt");

-- CreateIndex
CREATE INDEX "StrategyPaperTrade_strategyId_status_idx" ON "StrategyPaperTrade"("strategyId", "status");

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyBacktest" ADD CONSTRAINT "StrategyBacktest_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyPaperTrade" ADD CONSTRAINT "StrategyPaperTrade_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
