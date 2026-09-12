-- Data Foundation V7 §3 — versioned instrument-master snapshot (additive, new tables).

CREATE TABLE IF NOT EXISTS "instrument_master_snapshot" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "snapshotVersion" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "fnoUniverseCount" INTEGER NOT NULL DEFAULT 0,
    "fnoEquityCount" INTEGER NOT NULL DEFAULT 0,
    "fnoFutureCount" INTEGER NOT NULL DEFAULT 0,
    "fnoOptionCount" INTEGER NOT NULL DEFAULT 0,
    "fnoIndexCount" INTEGER NOT NULL DEFAULT 0,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "instrument_master_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "instrument_master_snapshot_snapshotVersion_key"
    ON "instrument_master_snapshot" ("snapshotVersion");
CREATE INDEX IF NOT EXISTS "instrument_master_snapshot_provider_createdAt_idx"
    ON "instrument_master_snapshot" ("provider", "createdAt");
CREATE INDEX IF NOT EXISTS "instrument_master_snapshot_checksum_idx"
    ON "instrument_master_snapshot" ("checksum");

CREATE TABLE IF NOT EXISTS "instrument_master_entry" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "instrumentKey" TEXT,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "segment" TEXT,
    "instrumentType" TEXT NOT NULL,
    "isin" TEXT,
    "symbolToken" TEXT,
    "expiry" TEXT,
    "strike" DOUBLE PRECISION,
    "optionType" TEXT,
    "lotSize" INTEGER,
    "tickSize" DOUBLE PRECISION,
    "underlying" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    CONSTRAINT "instrument_master_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "instrument_master_entry_snapshotId_idx"
    ON "instrument_master_entry" ("snapshotId");
CREATE INDEX IF NOT EXISTS "instrument_master_entry_provider_instrumentType_idx"
    ON "instrument_master_entry" ("provider", "instrumentType");
CREATE INDEX IF NOT EXISTS "instrument_master_entry_underlying_expiry_idx"
    ON "instrument_master_entry" ("underlying", "expiry");
CREATE INDEX IF NOT EXISTS "instrument_master_entry_symbol_idx"
    ON "instrument_master_entry" ("symbol");

DO $$ BEGIN
    ALTER TABLE "instrument_master_entry"
        ADD CONSTRAINT "instrument_master_entry_snapshotId_fkey"
        FOREIGN KEY ("snapshotId") REFERENCES "instrument_master_snapshot"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
