/**
 * FnO Trend Scanner history — persistence + live-tracking.
 *
 * Lifecycle:
 *   1. After each successful scan, `snapshotFnoTrendScan()` is called with
 *      the full hit list. It upserts one `FnoTrendScan` row per symbol per
 *      (tradeDate, scanType) — idempotent so repeated calls within the same
 *      day are safe.
 *   2. `trackOpenFnoTrendScans()` is called by the worker every minute
 *      during market hours. It fetches the latest quote for every OPEN row
 *      on today's date and checks whether it has hit TP1 or SL. Rows still
 *      open at 15:30 IST are squared off (CLOSED).
 *   3. `getFnoTrendHistory()` exposes the queried history for the API.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { istDateKey } from "@/features/india/daily-picks/engine";
import {
  isNseMarketOpenIST,
  isNseSessionEndedForDateIST,
} from "@/lib/india/market-hours";
import type { ScannerHit } from "@/types/india/scanner";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FnoTrendStatus = "OPEN" | "TARGET_HIT" | "STOP_HIT" | "CLOSED" | "EXPIRED";

export interface FnoTrendScanRow {
  id: string;
  tradeDate: string;
  /** "BULLISH" | "BEARISH" */
  scanType: string;
  symbol: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  atr: number;
  adxVal: number;
  rsiVal: number;
  changePct: number;
  status: FnoTrendStatus;
  lastPrice: number | null;
  pnlPct: number | null;
  resolvedAt: Date | null;
  scannedAt: Date;
  updatedAt: Date;
}

export interface FnoTrendHistoryDay {
  tradeDate: string;
  scans: FnoTrendScanRow[];
  summary: {
    total: number;
    targetHit: number;
    stopHit: number;
    closed: number;
    open: number;
    winRate: number;
  };
}

export interface FnoTrendHistoryResponse {
  generatedAt: number;
  days: FnoTrendHistoryDay[];
}

// ─── DB helper ────────────────────────────────────────────────────────────────

function safeGetPrisma(): PrismaClient | null {
  try { return getPrisma(); } catch { return null; }
}

// ─── 1. Snapshot: called after each scan run ─────────────────────────────────

/**
 * Upsert today's scan results into `FnoTrendScan`. Only fires when the NSE
 * session has opened (09:15 IST) — pre-market results would lock in stale
 * previous-close levels.
 */
export async function snapshotFnoTrendScan(
  hits: ScannerHit[],
  scanType: "BULLISH" | "BEARISH",
  prisma?: PrismaClient,
): Promise<void> {
  const db = prisma ?? safeGetPrisma();
  if (!db) return;

  const now = new Date();
  const tradeDate = istDateKey(now);

  // Don't persist before the session opens.
  if (!isNseMarketOpenIST(now)) return;

  // ── V6 §20 FAIL-CLOSED DATA GATE (producer-level) ──────────────────────────
  // The 14-condition trend scan is computed from DAILY indicators (MA/ADX/MACD/
  // ATR/RSI). Before a hit is persisted as a track-record row, its symbol must
  // have enough REAL persisted daily history for those indicators to warm up.
  // A symbol whose daily data is genuinely unavailable/insufficient is DROPPED
  // (NO SIGNAL) rather than persisted on data we don't have (§20/§42). This is a
  // data-integrity veto ONLY — it never reads or changes the scan conditions.
  const gatedHits = await gateHitsByData(hits, db);
  if (gatedHits.length === 0) return;

  const upserts = gatedHits.map((h) => {
    const entry    = h.entry    ?? h.price ?? 0;
    const stopLoss = h.stopLoss ?? 0;
    const tp1      = h.tp1      ?? 0;
    const tp2      = h.tp2      ?? 0;
    const tp3      = h.tp3      ?? 0;
    const atr      = h.atr      ?? 0;

    // Parse adxVal / rsiVal out of metricLabel ("ADX 34.5 · RSI 62")
    const adxMatch = h.metricLabel.match(/ADX\s+([\d.]+)/);
    const rsiMatch = h.metricLabel.match(/RSI\s+([\d.]+)/);
    const adxVal   = adxMatch ? parseFloat(adxMatch[1]) : 0;
    const rsiVal   = rsiMatch ? parseFloat(rsiMatch[1]) : 0;

    return db.fnoTrendScan.upsert({
      where: {
        tradeDate_scanType_symbol: { tradeDate, scanType, symbol: h.symbol },
      },
      create: {
        tradeDate,
        scanType,
        symbol:    h.symbol,
        entry,
        stopLoss,
        tp1,
        tp2,
        tp3,
        atr,
        adxVal,
        rsiVal,
        changePct: h.changePct ?? 0,
        status:    "OPEN",
        lastPrice: h.price,
      },
      // Only update price-insensitive indicator fields on re-run;
      // never overwrite entry/SL/TP once frozen.
      update: {
        adxVal,
        rsiVal,
        changePct: h.changePct ?? 0,
        lastPrice: h.price,
      },
    });
  });

  await Promise.allSettled(upserts);
}

/**
 * V6 §20/§21 producer data gate for the FnO trend scan. Filters scanner hits to
 * those whose symbol has sufficient persisted daily history (the scan's warm-up
 * window). Fails CLOSED: a gate-read error drops the hit. Never throws.
 */
const FNO_SCAN_WARMUP_BARS = 30; // MA/ADX/MACD/ATR/RSI(14) daily warm-up floor.
async function gateHitsByData(
  hits: ScannerHit[],
  db: PrismaClient,
): Promise<ScannerHit[]> {
  try {
    const { evaluateProducerDataGate } = await import(
      "@/lib/market-data/services/producer-data-gate.service"
    );
    const kept: ScannerHit[] = [];
    for (const h of hits) {
      const gate = await evaluateProducerDataGate({
        instrumentId: h.symbol,
        exchange: "NSE",
        interval: "1d",
        requiredBars: FNO_SCAN_WARMUP_BARS,
        requireFullyReady: false,
        prisma: db,
      });
      if (gate.allowed) kept.push(h);
      else console.warn(`[fno-trend] data gate blocked ${h.symbol}: ${gate.reason}`);
    }
    return kept;
  } catch (err) {
    console.warn("[fno-trend] data gate unavailable — failing closed (no snapshot this run):", (err as Error).message);
    return [];
  }
}

// ─── 2. Live-tracking: called by the worker every minute ─────────────────────

/**
 * For every OPEN `FnoTrendScan` row on today's date, fetch the latest quote
 * from the canonical registry and check TP1 / SL. Rows still open at 15:30 IST
 * are CLOSED.
 */
export async function trackOpenFnoTrendScans(prisma?: PrismaClient): Promise<void> {
  const db = prisma ?? safeGetPrisma();
  if (!db) return;

  const now       = new Date();
  const tradeDate = istDateKey(now);
  const sessionEnded = isNseSessionEndedForDateIST(tradeDate, now);

  const openRows = (await db.fnoTrendScan.findMany({
    where: { tradeDate, status: "OPEN" },
    orderBy: { symbol: "asc" },
  })) as unknown as FnoTrendScanRow[];

  if (openRows.length === 0) return;

  // Fetch quotes in one batch via canonical registry
  const symbols = [...new Set(openRows.map((r) => r.symbol))];
  const quoteMap: Map<string, number> = new Map();
  try {
    const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
    await bootstrapRegistry();
    const mdQuotes = await registry.getQuotes(symbols);
    for (const q of mdQuotes) {
      if (q?.ltp != null && Number.isFinite(q.ltp)) {
        quoteMap.set(q.symbol.replace(".NS", ""), q.ltp);
      }
    }
  } catch {
    // Fail-soft — skip tracking this tick
    return;
  }

  const updates: Array<Promise<unknown>> = [];

  for (const row of openRows) {
    const price = quoteMap.get(row.symbol) ?? quoteMap.get(`${row.symbol}.NS`) ?? null;

    if (sessionEnded) {
      // Square off at session close
      const closePrice = price ?? row.entry;
      const pnlPct     = pnl(row.entry, closePrice, row.scanType);
      updates.push(
        db.fnoTrendScan.update({
          where: { id: row.id },
          data:  { status: "CLOSED", lastPrice: closePrice, pnlPct, resolvedAt: now },
        }),
      );
      continue;
    }

    if (price == null) continue;

    const isBull = row.scanType === "BULLISH";
    let newStatus: FnoTrendStatus | null = null;

    if (isBull) {
      if (price >= row.tp1)   newStatus = "TARGET_HIT";
      else if (price <= row.stopLoss) newStatus = "STOP_HIT";
    } else {
      if (price <= row.tp1)   newStatus = "TARGET_HIT";   // bearish TP is below entry
      else if (price >= row.stopLoss) newStatus = "STOP_HIT";
    }

    const pnlPct = pnl(row.entry, price, row.scanType);
    updates.push(
      db.fnoTrendScan.update({
        where: { id: row.id },
        data:  {
          lastPrice: price,
          pnlPct,
          ...(newStatus ? { status: newStatus, resolvedAt: now } : {}),
        },
      }),
    );
  }

  await Promise.allSettled(updates);
}

function pnl(entry: number, exit: number, scanType: string): number {
  if (entry <= 0) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return scanType === "BEARISH" ? -raw : raw;
}

// ─── 3. History query: called by the API ─────────────────────────────────────

export async function getFnoTrendHistory(opts?: {
  days?: number;
  scanType?: "BULLISH" | "BEARISH" | "ALL";
  excludeDate?: string;
  prisma?: PrismaClient;
}): Promise<FnoTrendHistoryResponse> {
  const now = Date.now();
  const db  = opts?.prisma ?? safeGetPrisma();
  if (!db) return { generatedAt: now, days: [] };

  try {
    const days    = Math.min(Math.max(opts?.days ?? 14, 1), 60);
    const exclude = opts?.excludeDate ?? istDateKey(new Date(now));
    const scanFilter = (opts?.scanType ?? "ALL") === "ALL"
      ? {}
      : { scanType: opts!.scanType! };

    const dateRows = (await db.fnoTrendScan.findMany({
      where: { tradeDate: { not: exclude }, ...scanFilter },
      distinct: ["tradeDate"],
      orderBy: { tradeDate: "desc" },
      take: days,
      select: { tradeDate: true },
    })) as Array<{ tradeDate: string }>;

    if (dateRows.length === 0) return { generatedAt: now, days: [] };
    const dates = dateRows.map((r) => r.tradeDate);

    const rows = (await db.fnoTrendScan.findMany({
      where: { tradeDate: { in: dates }, ...scanFilter },
      orderBy: [{ tradeDate: "desc" }, { scanType: "asc" }, { changePct: "desc" }],
    })) as unknown as FnoTrendScanRow[];

    // Group by date
    const byDate = new Map<string, FnoTrendScanRow[]>();
    for (const row of rows) {
      const arr = byDate.get(row.tradeDate) ?? [];
      arr.push(row);
      byDate.set(row.tradeDate, arr);
    }

    const historyDays: FnoTrendHistoryDay[] = dates.map((date) => {
      const scans = byDate.get(date) ?? [];
      const targetHit = scans.filter((s) => s.status === "TARGET_HIT").length;
      const stopHit   = scans.filter((s) => s.status === "STOP_HIT").length;
      const closed    = scans.filter((s) => s.status === "CLOSED" || s.status === "EXPIRED").length;
      const open      = scans.filter((s) => s.status === "OPEN").length;
      const resolved  = targetHit + stopHit;
      return {
        tradeDate: date,
        scans,
        summary: {
          total: scans.length,
          targetHit,
          stopHit,
          closed,
          open,
          winRate: resolved > 0 ? targetHit / resolved : 0,
        },
      };
    });

    return { generatedAt: now, days: historyDays };
  } catch (err) {
    console.error("[fno-trend-history] query failed:", (err as Error).message);
    return { generatedAt: now, days: [] };
  }
}
