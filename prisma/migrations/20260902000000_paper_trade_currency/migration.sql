-- USD-001 Fix: add `currency` column to PaperTrade and StrategyPaperTrade.
--
-- Background: pnlUsd is a legacy name from the crypto scalper where
-- notional = $1,000. India paper trades reuse the same table with
-- notional = ₹20,000 so pnlUsd stores INR values. The `currency` column
-- makes the denomination explicit at the row level so UI layers and
-- analytics can format values correctly without inspecting the `source`
-- prefix.
--
-- Default is "USD" (backward-compatible: all existing crypto rows stay
-- correct). India paper trades set currency = "INR" at write time going
-- forward.

ALTER TABLE "PaperTrade"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE "StrategyPaperTrade"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
