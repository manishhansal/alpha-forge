/**
 * India Auto Paper-Trading Worker Job
 *
 * Tick cadence: every 60 seconds during market hours (09:15–15:30 IST).
 *
 * Two phases per tick:
 *   1. runAutoTradeTick()       — score signals, open top trades within ₹1L budget
 *   2. finaliseAutoTradingSession() — at/after 15:30 IST, close all open trades
 *                                     and compute final session stats
 *
 * The job is deliberately silent outside market hours — it returns immediately
 * without DB work so there's no off-hours noise in the logs.
 */

import { isNseMarketOpenIST, isNseSessionEndedForDateIST } from "@/lib/india/market-hours";
import { istDateKey } from "@/features/india/daily-picks/engine";
import {
  runAutoTradeTick,
  finaliseAutoTradingSession,
} from "@/features/india/paper-trading/auto-trader";

import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-auto-trader");

export function startIndiaAutoTraderJob(): JobHandle {
  return scheduleJob(
    {
      name:       "india-auto-trader",
      intervalMs: 60_000,
      runOnStart: true,
      tick: async () => {
        const child = log.child("tick");
        const now   = new Date();

        // ── Phase 2: EOD finalisation ────────────────────────────────────
        // Check first so the 15:30 tick that exits the market-open window
        // still triggers the close-out.
        const tradeDate = istDateKey(now);
        if (isNseSessionEndedForDateIST(tradeDate, now)) {
          try {
            await finaliseAutoTradingSession();
            child.info("session finalised");
          } catch (err) {
            child.warn("finalisation failed", { err: (err as Error).message });
          }
          return;
        }

        // ── Phase 1: open new trades ─────────────────────────────────────
        if (!isNseMarketOpenIST(now)) return;

        try {
          const result = await runAutoTradeTick();
          if (result.opened > 0 || result.skipped > 0) {
            child.info("tick complete", {
              opened:  result.opened,
              skipped: result.skipped,
              reason:  result.reason,
            });
          }
        } catch (err) {
          child.warn("tick failed", { err: (err as Error).message });
        }
      },
    },
    log,
  );
}
