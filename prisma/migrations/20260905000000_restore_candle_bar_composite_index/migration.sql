-- Restore the explicit composite index on CandleBar that was dropped in
-- migration 20260904034937 (DB-004). While PostgreSQL automatically creates
-- a B-tree index to enforce the @@unique constraint, having an explicit named
-- index ensures test assertions that check for its presence continue to pass
-- and aligns the Prisma schema with the actual DB state.
CREATE INDEX IF NOT EXISTS "candle_bar_instrumentId_exchange_intervalStr_time_idx"
    ON "candle_bar"("instrumentId", "exchange", "intervalStr", "time");
