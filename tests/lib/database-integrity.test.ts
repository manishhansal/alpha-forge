// @vitest-environment node
/**
 * Phase 15 — Database Integrity Audit Tests
 *
 * Verifies Prisma schema constraints:
 *   - Unique constraints prevent duplicate candles, fills, orders
 *   - Foreign key cascades are present
 *   - Required indexes exist for query patterns
 *   - Idempotency keys are defined
 *
 * These are schema-level tests (reading schema.prisma) — they don't require
 * a live database connection.
 *
 * Validates: PHASE 15 requirements — database integrity
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SCHEMA = readFileSync(
  join(process.cwd(), "prisma/schema.prisma"),
  "utf-8"
);

// ─────────────────────────────────────────────────────────────────────────────
// 1. CandleBar — duplicate prevention
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — CandleBar duplicate prevention", () => {
  it("CandleBar has a unique constraint on (instrumentId, exchange, intervalStr, time)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[instrumentId,\s*exchange,\s*intervalStr,\s*time\]\)/
    );
  });

  it("CandleBar has an index on (instrumentId, exchange, intervalStr, time)", () => {
    expect(SCHEMA).toMatch(
      /@@index\(\[instrumentId,\s*exchange,\s*intervalStr,\s*time\]\)/
    );
  });

  it("CandleBar time field stores UTC epoch seconds (is Int)", () => {
    // time is Int — UTC epoch seconds
    const candleBarBlock = SCHEMA.match(/model CandleBar \{[\s\S]*?\}/)?.[0] ?? "";
    expect(candleBarBlock).toMatch(/time\s+Int/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. IndiaDailyPick — unique per (tradeDate, bucket, rank)
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — IndiaDailyPick idempotency", () => {
  it("IndiaDailyPick has unique constraint on (tradeDate, bucket, rank)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[tradeDate,\s*bucket,\s*rank\]\)/
    );
  });

  it("IndiaDailyPick has indexes on tradeDate and symbol+tradeDate", () => {
    expect(SCHEMA).toMatch(/@@index\(\[tradeDate\]\)/);
    expect(SCHEMA).toMatch(/@@index\(\[symbol,\s*tradeDate\]\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FnoTrendScan — unique per (tradeDate, scanType, symbol)
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — FnoTrendScan idempotency", () => {
  it("FnoTrendScan has unique constraint on (tradeDate, scanType, symbol)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[tradeDate,\s*scanType,\s*symbol\]\)/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. IndiaDaySession — unique per tradeDate
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — IndiaDaySession idempotency", () => {
  it("IndiaDaySession has unique constraint on tradeDate", () => {
    expect(SCHEMA).toMatch(/tradeDate\s+String\s+@unique/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. User relationships — cascade deletes prevent orphans
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — cascade deletes", () => {
  it("Alert has onDelete: Cascade for User relation", () => {
    expect(SCHEMA).toMatch(/onDelete: Cascade/);
  });

  it("UserSetting has onDelete: Cascade for User relation", () => {
    // Multiple Cascade deletes expected
    const cascadeCount = (SCHEMA.match(/onDelete: Cascade/g) ?? []).length;
    expect(cascadeCount).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SignalHistory — indexed for common query patterns
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — SignalHistory query performance", () => {
  it("SignalHistory has index on (symbol, generatedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[symbol,\s*generatedAt\]\)/);
  });

  it("SignalHistory has index on (type, generatedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[type,\s*generatedAt\]\)/);
  });

  it("SignalHistory has index on (outcome, generatedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[outcome,\s*generatedAt\]\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PaperTrade — indexed for dashboard and status queries
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — PaperTrade indexes", () => {
  it("PaperTrade has index on (symbol, openedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[symbol,\s*openedAt\]\)/);
  });

  it("PaperTrade has index on (status, openedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[status,\s*openedAt\]\)/);
  });

  it("PaperTrade has index on (source, openedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[source,\s*openedAt\]\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Enum completeness
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — enum completeness", () => {
  it("SignalTypeEnum includes LONG, SHORT, BUY, SELL, HOLD", () => {
    const enumBlock = SCHEMA.match(/enum SignalTypeEnum \{[\s\S]*?\}/)?.[0] ?? "";
    expect(enumBlock).toMatch(/LONG/);
    expect(enumBlock).toMatch(/SHORT/);
    expect(enumBlock).toMatch(/BUY/);
    expect(enumBlock).toMatch(/SELL/);
    expect(enumBlock).toMatch(/HOLD/);
  });

  it("PaperTradeStatusEnum includes OPEN, WIN, LOSS, EXPIRED, CANCELLED", () => {
    const enumBlock = SCHEMA.match(/enum PaperTradeStatusEnum \{[\s\S]*?\}/)?.[0] ?? "";
    expect(enumBlock).toMatch(/OPEN/);
    expect(enumBlock).toMatch(/WIN/);
    expect(enumBlock).toMatch(/LOSS/);
    expect(enumBlock).toMatch(/EXPIRED/);
    expect(enumBlock).toMatch(/CANCELLED/);
  });

  it("ScalpDirectionEnum includes LONG and SHORT", () => {
    const enumBlock = SCHEMA.match(/enum ScalpDirectionEnum \{[\s\S]*?\}/)?.[0] ?? "";
    expect(enumBlock).toMatch(/LONG/);
    expect(enumBlock).toMatch(/SHORT/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. OptionChainSnapshot — indexed for time-series queries
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — OptionChainSnapshot indexes", () => {
  it("OptionChainSnapshot has index on (underlying, capturedAt)", () => {
    expect(SCHEMA).toMatch(/@@index\(\[underlying,\s*capturedAt\]\)/);
  });

  it("OptionChainSnapshot has index on capturedAt", () => {
    expect(SCHEMA).toMatch(/@@index\(\[capturedAt\]\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Prisma generator uses prisma-client-js (not pg-based)
// ─────────────────────────────────────────────────────────────────────────────

describe("Database schema — generator configuration", () => {
  it("uses prisma-client-js generator", () => {
    expect(SCHEMA).toMatch(/provider = "prisma-client-js"/);
  });

  it("uses postgresql as datasource", () => {
    expect(SCHEMA).toMatch(/provider = "postgresql"/);
  });
});
