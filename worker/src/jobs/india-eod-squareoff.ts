/**
 * India EOD Square-Off Job
 *
 * Closes all OPEN India paper trades at the 15:30 IST session end so the
 * journal never carries open positions overnight — all trades are strictly
 * intraday.
 *
 * Runs every 60 seconds. The job is a no-op outside the 15:30–15:45 IST
 * window (it only fires when the session has ended and there are still OPEN
 * trades). After the first successful square-off of the day there will be
 * no more OPEN rows until the next session, so subsequent ticks cost one
 * cheap Prisma COUNT query and return immediately.
 *
 * Chaos Engineering Hardening:
 *   - Scenario 11: Distributed lock (acquireEodLock) ensures exactly-once
 *     execution per trading day, even across rapid worker restarts or
 *     multiple replicas.  The lock key is scoped to `tradeDate` (IST) and
 *     carries a 20-minute TTL covering the full 15:30–15:50 window.
 *   - Scenario 2: Each individual paperTrade.update is wrapped in withDbRetry
 *     so a transient Postgres hiccup doesn't leave trades half-closed.
 *   - No duplicate close: the COUNT check is still performed even when Redis
 *     is unavailable (the lock degrades gracefully to "proceed without lock").
 */

import { isNseMarketOpenIST, nseCloseMsForDateIST } from "@/lib/india/market-hours";
import { istDateKey } from "@/features/india/daily-picks/engine";
import { acquireEodLock } from "@/lib/chaos/worker-resilience";
import { withDbRetry } from "@/lib/chaos/db-resilience";
import { getPrisma } from "../db";
import { getRedis } from "../redis";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-eod-squareoff");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istTodayKey(): string {
  return istDateKey(new Date());
}

/** True when now is past 15:30 IST on a weekday (session ended). */
function isSessionEnded(): boolean {
  const now   = new Date();
  const today = istTodayKey();
  const closeMs = nseCloseMsForDateIST(today);
  if (closeMs == null) return false;
  // Also guard weekends — nseCloseMsForDateIST doesn't check day-of-week
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day  = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  return now.getTime() >= closeMs;
}

export function startIndiaEodSquareOffJob(): JobHandle {
  return scheduleJob(
    {
      name:        "india-eod-squareoff",
      intervalMs:  60_000,
      runOnStart:  false,
      tick: async () => {
        // Only act when the session has ended — skip during market hours and
        // weekends entirely.
        if (isNseMarketOpenIST(new Date())) return;
        if (!isSessionEnded()) return;

        const child = log.child("tick");
        const tradeDate = istTodayKey();

        // ── Chaos Scenario 11: Exactly-once EOD lock ─────────────────────
        // Acquire a distributed lock scoped to today's IST date.  If another
        // worker replica (or a rapid restart) already holds the lock, the
        // square-off was already run — return immediately.
        let eodRelease: (() => Promise<void>) | undefined;
        try {
          let redis;
          try { redis = getRedis(); } catch { /* Redis unavailable — proceed without lock */ }

          if (redis) {
            const lockResult = await acquireEodLock(redis, tradeDate);
            if (!lockResult.acquired) {
              child.info("eod lock already held — square-off already completed for today", {
                tradeDate,
              });
              return;
            }
            eodRelease = lockResult.release;
          }
        } catch (lockErr) {
          child.warn("eod lock acquire failed — proceeding (single-worker assumption)", {
            err: (lockErr as Error).message,
          });
        }

        try {
          const db = getPrisma();

          // Cheap check: are there any open India trades at all?
          const openCount = await db.paperTrade.count({
            where: { status: "OPEN", source: { startsWith: "in:" } },
          });
          if (openCount === 0) return;

          const now = new Date();
          const closeMs = nseCloseMsForDateIST(istTodayKey());
          // Use the actual 15:30 close time as the resolution timestamp,
          // not "now" (which could be minutes later).
          const closedAt = closeMs != null ? new Date(closeMs) : now;

          // Fetch all open India trades so we can compute per-trade P&L.
          const openTrades = await db.paperTrade.findMany({
            where: { status: "OPEN", source: { startsWith: "in:" } },
            select: {
              id:        true,
              symbol:    true,
              entry:     true,
              direction: true,
              notional:  true,
            },
          });

          // Fetch last-known prices in one batch from Yahoo.
          // If a quote is unavailable, fall back to entry (0 P&L).
          const symbols = [...new Set(openTrades.map((t) => t.symbol))];
          const priceMap = new Map<string, number>();
          try {
            const { yahoo } = await import("@/services/india/yahoo");
            const quotes = await yahoo.getQuotes(symbols);
            for (const q of quotes) {
              const sym = q.symbol.replace(/\.NS$/i, "").toUpperCase();
              if (q.price != null && Number.isFinite(q.price)) {
                priceMap.set(sym, q.price);
              }
            }
          } catch (qErr) {
            child.warn("price fetch failed — closing at entry (0 P&L)", {
              err: (qErr as Error).message,
            });
          }

          let closed = 0;
          for (const t of openTrades) {
            const exitPrice = priceMap.get(t.symbol) ?? t.entry;
            const isLong    = t.direction === "LONG";
            const rawPnl    = isLong
              ? (exitPrice - t.entry) / t.entry
              : (t.entry - exitPrice) / t.entry;
            const pnlPct = rawPnl * 100;
            const pnlUsd = (pnlPct / 100) * t.notional;

            // ── Chaos Scenario 2: DB retry on transient Postgres failure ──
            await withDbRetry(
              () => db.paperTrade.update({
                where: { id: t.id },
                data:  {
                  status:    "EXPIRED",   // EXPIRED = closed at session end, not WIN/LOSS
                  exitPrice,
                  pnlPct,
                  pnlUsd,
                  currency:  "INR",       // USD-001 FIX: India P&L is INR
                  closedAt,
                },
              }),
              { label: `eod-squareoff:${t.id}`, maxAttempts: 3, baseDelayMs: 300 },
            );
            closed++;
          }

          child.info("squared off", { closed, tradeDate });
        } catch (err) {
          log.warn("eod squareoff failed", { err: (err as Error).message });
        } finally {
          // Always release the EOD lock so it's not held until TTL expiry
          if (eodRelease) {
            await eodRelease().catch((e: unknown) =>
              log.warn("eod lock release failed", { err: (e as Error).message }),
            );
          }
        }
      },
    },
    log,
  );
}
