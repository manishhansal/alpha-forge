-- CreateEnum
CREATE TYPE "SymbolEnum" AS ENUM ('BTC', 'ETH', 'SOL');

-- CreateEnum
CREATE TYPE "SignalTypeEnum" AS ENUM ('LONG', 'SHORT', 'BUY', 'SELL', 'HOLD');

-- CreateEnum
CREATE TYPE "RiskLevelEnum" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "AlertTypeEnum" AS ENUM ('FUNDING_SPIKE', 'OI_BREAKOUT', 'PRICE_BREAKOUT', 'LIQUIDATION_SURGE', 'SIGNAL_CHANGE');

-- CreateEnum
CREATE TYPE "AlertChannelEnum" AS ENUM ('IN_APP', 'EMAIL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "SignalOutcomeEnum" AS ENUM ('OPEN', 'HIT_TARGET', 'HIT_STOP', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationKindEnum" AS ENUM ('ALERT', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalHistory" (
    "id" TEXT NOT NULL,
    "symbol" "SymbolEnum" NOT NULL,
    "type" "SignalTypeEnum" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "risk" "RiskLevelEnum" NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "riskReward" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT[],
    "features" JSONB NOT NULL,
    "outcome" "SignalOutcomeEnum" NOT NULL DEFAULT 'OPEN',
    "pnlPct" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" "SymbolEnum" NOT NULL,
    "type" "AlertTypeEnum" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "comparator" TEXT NOT NULL,
    "channels" "AlertChannelEnum"[],
    "webhookUrl" TEXT,
    "cooldownSec" INTEGER NOT NULL DEFAULT 900,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "triggeredAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "defaultPair" "SymbolEnum" NOT NULL DEFAULT 'BTC',
    "apiKeysEncrypted" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKindEnum" NOT NULL DEFAULT 'ALERT',
    "alertId" TEXT,
    "symbol" "SymbolEnum",
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "SignalHistory_symbol_generatedAt_idx" ON "SignalHistory"("symbol", "generatedAt");

-- CreateIndex
CREATE INDEX "SignalHistory_type_generatedAt_idx" ON "SignalHistory"("type", "generatedAt");

-- CreateIndex
CREATE INDEX "SignalHistory_outcome_generatedAt_idx" ON "SignalHistory"("outcome", "generatedAt");

-- CreateIndex
CREATE INDEX "Alert_userId_active_idx" ON "Alert"("userId", "active");

-- CreateIndex
CREATE INDEX "Alert_symbol_type_active_idx" ON "Alert"("symbol", "type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "UserSetting_userId_key" ON "UserSetting"("userId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSetting" ADD CONSTRAINT "UserSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;
