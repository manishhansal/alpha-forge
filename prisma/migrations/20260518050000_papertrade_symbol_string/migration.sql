-- Convert `PaperTrade.symbol` from the `SymbolEnum` (BTC / ETH / SOL only)
-- to a free-form TEXT column so the same table can persist India F&O
-- tickers (NIFTY, BANKNIFTY, RELIANCE, …) alongside the existing crypto
-- rows. Existing values are preserved verbatim — the enum labels become
-- the strings "BTC", "ETH", "SOL" via the USING clause.
--
-- The two markets continue to stay in their own lanes via the `source`
-- column (crypto: `<id>:<tf>`, India: `in:<id>:<tf>`). The
-- `PaperTrade_symbol_openedAt_idx` index is rebuilt automatically by
-- Postgres against the new column type and keeps its name.
--
-- The other tables that still reference `SymbolEnum` (SignalHistory,
-- Alert, UserSetting.defaultPair, Notification, Strategy.symbols,
-- StrategyBacktest, StrategyPaperTrade) are intentionally NOT migrated
-- here — their consumers are crypto-only today, so the enum still gives
-- them a useful type-safety guard. They will be migrated individually
-- as their India equivalents land.

-- AlterTable
ALTER TABLE "PaperTrade"
  ALTER COLUMN "symbol" TYPE TEXT USING "symbol"::TEXT;
