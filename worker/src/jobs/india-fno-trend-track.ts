import { isNseMarketOpenIST } from "@/lib/india/market-hours";
import { trackOpenFnoTrendScans } from "@/features/india/fno-trend-history/service";

import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-fno-trend-track");

/**
 * Live-tracks open FnO Bullish / Bearish Trend Scanner rows against current
 * price, resolving TARGET_HIT / STOP_HIT as price moves, and CLOSED at the
 * 15:30 IST session end.
 *
 * Runs every 60 seconds (matching the daily-picks cadence). Ticks outside
 * market hours are skipped — open rows will be squared off on the next tick
 * after 15:30 IST, or at the next morning's first tick.
 */
export function startIndiaFnoTrendTrackJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-fno-trend-track",
      intervalMs: 60_000,
      runOnStart: true,
      tick: async () => {
        const child = log.child("tick");
        if (!isNseMarketOpenIST(new Date())) return;

        try {
          await trackOpenFnoTrendScans();
          child.info("tracked");
        } catch (err) {
          child.warn("tracking failed", { err: (err as Error).message });
        }
      },
    },
    log,
  );
}
