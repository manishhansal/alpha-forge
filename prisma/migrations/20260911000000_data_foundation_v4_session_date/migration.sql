-- Data Foundation V4 — canonical daily session-date key (additive, safe).
-- Adds a nullable sessionDate column to candle_bar and a PARTIAL UNIQUE index
-- that enforces one daily candle per (instrumentId, exchange, sessionDate) for
-- interval='1d' rows that carry a sessionDate. Existing rows keep sessionDate
-- NULL (excluded from the partial index) until the operator-approved daily
-- normalization migration backfills them, so this migration NEVER conflicts
-- with the current mixed-convention data and mutates no existing row.

-- 1. Additive nullable column (no default, no backfill).
ALTER TABLE "candle_bar" ADD COLUMN IF NOT EXISTS "sessionDate" TEXT;

-- 2. Non-unique covering index for sessionDate lookups.
CREATE INDEX IF NOT EXISTS "candle_bar_instrumentId_exchange_sessionDate_idx"
  ON "candle_bar" ("instrumentId", "exchange", "sessionDate");

-- 3. Partial UNIQUE index: at most one daily row per trading session, but ONLY
--    for rows that (a) are daily and (b) have a non-null sessionDate. Rows with
--    NULL sessionDate (all existing 89,810 rows today) are excluded, so this is
--    safe to apply immediately and starts enforcing uniqueness for new writes.
CREATE UNIQUE INDEX IF NOT EXISTS "candle_bar_daily_session_unique"
  ON "candle_bar" ("instrumentId", "exchange", "sessionDate")
  WHERE "intervalStr" = '1d' AND "sessionDate" IS NOT NULL;
