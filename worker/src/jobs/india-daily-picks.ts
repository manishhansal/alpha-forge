import { getIndiaDailyPicks } from "@/features/india/daily-picks/builder";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

import { workerConfig } from "../config";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-daily-picks");

/**
 * India F&O Daily Picks refresh.
 *
 * `getIndiaDailyPicks()` is freeze-or-track: the first in-session call of an
 * IST trading day freezes the top-3-per-bucket picks (entry / stop / target
 * locked) into `IndiaDailyPick`; every later call live-tracks them (P&L,
 * progress-to-target, TARGET_HIT / STOP_HIT) and persists the update in place.
 *
 * Running this on a cadence means the day's picks are frozen and tracked even
 * if nobody opens the page — so the history accrues a complete record. Ticks
 * outside the regular NSE session are skipped (the picks are already resolved
 * for the day; off-hours marks would only add noise).
 */
export function startIndiaDailyPicksJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-daily-picks",
      intervalMs: workerConfig.indiaDailyPicks.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");
        if (!isNseMarketOpenIST(new Date())) return;

        try {
          const res = await getIndiaDailyPicks();
          const picks = res.groups.flatMap((g) => g.picks);
          const resolved = picks.filter(
            (p) => p.status === "TARGET_HIT" || p.status === "STOP_HIT",
          ).length;
          child.info("refreshed", {
            tradeDate: res.tradeDate,
            persisted: res.persisted,
            picks: picks.length,
            resolved,
          });
          if (!res.persisted) {
            child.warn("picks not persisted — check DATABASE_URL / migrations");
          }
        } catch (err) {
          child.warn("refresh failed", { err: (err as Error).message });
        }
      },
    },
    log,
  );
}
