-- DropIndex
DROP INDEX "candle_bar_instrumentId_exchange_intervalStr_time_idx";

-- CreateIndex
CREATE INDEX "IndiaDailyPick_status_tradeDate_idx" ON "IndiaDailyPick"("status", "tradeDate");
