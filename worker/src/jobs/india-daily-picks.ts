import { getIndiaDailyPicks } from "@/features/india/daily-picks/builder";
import { dispatchWhatsApp } from "@/features/whatsapp/notifier";
import type { DailyPicksEvent } from "@/features/whatsapp/types";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { getRedis } from "../redis";
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
      runOnStart: true,
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

          // ── WhatsApp notifications for newly frozen picks ───────────────
          // Only dispatch when the WhatsApp channel is configured and the
          // picks were freshly persisted (res.persisted === true). The
          // cooldown gate in dispatchWhatsApp (23h TTL per tradeDate+bucket)
          // ensures we never send duplicate messages even if multiple ticks
          // see persisted===true on the same day.
          //
          // Requirements: 4.1, 10.3
          if (workerConfig.whatsapp.enabled && res.persisted && picks.length > 0) {
            let redis: ReturnType<typeof getRedis> | undefined;
            let prisma: ReturnType<typeof getPrisma> | undefined;
            try {
              redis = getRedis();
              prisma = getPrisma();
            } catch {
              // Redis or Prisma unavailable — dispatchWhatsApp handles this
              // gracefully; pass undefined and let it suppress internally.
            }

            for (const pick of picks) {
              const event: DailyPicksEvent = {
                type: "DAILY_PICKS_NEW",
                pick,
                tradeDate: res.tradeDate,
                bucket: pick.bucket,
                generatedAt: res.generatedAt,
              };

              // The pick's userId is not stored on the DailyPick model; daily
              // picks are system-generated signals for all subscribed users.
              // Use the system user sentinel "system" — dispatchWhatsApp will
              // look up the phone/preferences for each real user via the
              // preferences layer. If no per-user wiring is available yet,
              // the suppression path (no-phone) will handle it gracefully.
              //
              // NOTE: When per-user pick ownership is added, replace "system"
              // with pick.userId (or however the pick owner is tracked).
              void dispatchWhatsApp(event, "system", { redis, prisma }).catch(
                (err: unknown) =>
                  child.warn("whatsapp dispatch error", {
                    err: (err as Error).message,
                    symbol: pick.symbol,
                    bucket: pick.bucket,
                  }),
              );
            }
          }
        } catch (err) {
          child.warn("refresh failed", { err: (err as Error).message });
        }
      },
    },
    log,
  );
}
