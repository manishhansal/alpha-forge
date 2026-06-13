import { evaluateAlert, type AlertEvalContext } from "@/features/alerts/evaluate";
import { fireAlert } from "@/features/alerts/dispatch";
import {
  type AlertChannel,
  type AlertType,
  type Comparator,
} from "@/features/alerts/types";
import { getAllLiquidationBuckets } from "@/features/futures/liquidations";
import { getFuturesOverview } from "@/features/futures/aggregate";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import type { FuturesSymbolView, SignalType, SymbolId } from "@/types/market";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:alerts");

async function buildContext(): Promise<AlertEvalContext> {
  const [futuresRes, liqRes] = await Promise.allSettled([
    getFuturesOverview(),
    getAllLiquidationBuckets(),
  ]);

  const futures: Record<SymbolId, FuturesSymbolView | null> = { BTC: null, ETH: null, SOL: null };
  if (futuresRes.status === "fulfilled") {
    for (const v of futuresRes.value.symbols) futures[v.symbol] = v;
  } else {
    log.warn("futures overview failed", { err: futuresRes.reason?.message });
  }

  const liquidations =
    liqRes.status === "fulfilled"
      ? liqRes.value
      : ({ BTC: null, ETH: null, SOL: null } as AlertEvalContext["liquidations"]);

  const signalTrail: Record<SymbolId, SignalType[]> = { BTC: [], ETH: [], SOL: [] };
  const prisma = getPrisma();
  for (const s of TRACKED_SYMBOLS) {
    const rows = await prisma.signalHistory.findMany({
      where: { symbol: s.id, type: { not: "HOLD" } },
      orderBy: { generatedAt: "desc" },
      take: 2,
      select: { type: true },
    });
    signalTrail[s.id] = rows.map((r) => r.type as SignalType);
  }

  return { generatedAt: Date.now(), futures, liquidations, signalTrail };
}

export function startAlertsJob(): JobHandle {
  return scheduleJob(
    {
      name: "alerts",
      intervalMs: workerConfig.alerts.intervalMs,
      runOnStart: false,
      tick: async () => {
        const prisma = getPrisma();
        const redis = getRedis();

        const active = await prisma.alert.findMany({
          where: { active: true },
          select: {
            id: true,
            userId: true,
            type: true,
            symbol: true,
            threshold: true,
            comparator: true,
            channels: true,
            webhookUrl: true,
            cooldownSec: true,
            triggeredAt: true,
          },
        });
        if (active.length === 0) return;

        const ctx = await buildContext();

        let fired = 0;
        let suppressed = 0;
        let skipped = 0;

        for (const a of active) {
          const result = evaluateAlert(
            {
              type: a.type as AlertType,
              symbol: a.symbol as SymbolId,
              threshold: a.threshold,
              comparator: (a.comparator as Comparator) ?? "gt",
              triggeredAt: a.triggeredAt,
            },
            ctx,
          );
          if (!result) {
            skipped += 1;
            continue;
          }
          if (!result.fire) continue;

          const decision = await fireAlert(
            {
              id: a.id,
              userId: a.userId,
              type: a.type,
              symbol: a.symbol,
              channels: a.channels as AlertChannel[],
              webhookUrl: a.webhookUrl,
              cooldownSec: a.cooldownSec,
            },
            result,
            { prisma, redis },
          );
          if (decision.dispatched) {
            fired += 1;
            log.info("alert fired", {
              alertId: a.id,
              type: a.type,
              symbol: a.symbol,
              outcomes: decision.outcomes,
            });
          } else {
            suppressed += 1;
          }
        }

        if (fired > 0 || suppressed > 0 || skipped > 0) {
          log.debug("tick complete", { active: active.length, fired, suppressed, skipped });
        }
      },
    },
    log,
  );
}
