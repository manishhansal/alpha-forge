-- IndiaDaySession — one row per IST trading day for the auto paper-trader.
-- Tracks the ₹1L daily budget utilisation and final P&L.

CREATE TABLE "IndiaDaySession" (
    "id"              TEXT          NOT NULL,
    "tradeDate"       TEXT          NOT NULL,
    "startingCapital" DOUBLE PRECISION NOT NULL DEFAULT 100000,
    "deployed"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realisedPnl"     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realisedPnlPct"  DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTrades"     INTEGER       NOT NULL DEFAULT 0,
    "wins"            INTEGER       NOT NULL DEFAULT 0,
    "losses"          INTEGER       NOT NULL DEFAULT 0,
    "expired"         INTEGER       NOT NULL DEFAULT 0,
    "winRate"         DOUBLE PRECISION,
    "bestTradePct"    DOUBLE PRECISION,
    "worstTradePct"   DOUBLE PRECISION,
    "avgTradePct"     DOUBLE PRECISION,
    "maxDrawdownPct"  DOUBLE PRECISION,
    "finalised"       BOOLEAN       NOT NULL DEFAULT false,
    "tradeIds"        TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
    "openedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalisedAt"     TIMESTAMP(3),
    "updatedAt"       TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "IndiaDaySession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IndiaDaySession_tradeDate_key" ON "IndiaDaySession"("tradeDate");
CREATE INDEX "IndiaDaySession_tradeDate_idx"          ON "IndiaDaySession"("tradeDate");
CREATE INDEX "IndiaDaySession_finalised_tradeDate_idx" ON "IndiaDaySession"("finalised", "tradeDate");
