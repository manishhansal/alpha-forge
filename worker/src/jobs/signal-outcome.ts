import { evaluateSignal, type SignalOutcome } from "@/features/backtesting/evaluate";
import { getServerBroker } from "@/services/brokers/registry";
import type { SymbolId } from "@/types/market";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:signal-outcome");

/**
 * Walk open SignalHistory rows, fetch 1m klines from `generatedAt` to now,
 * and resolve their outcome (HIT_TARGET / HIT_STOP / EXPIRED). Conservative:
 * a single candle that touches both target and stop is recorded as a stop.
 */
export function startSignalOutcomeJob(): JobHandle {
  return scheduleJob(
    {
      name: "signal-outcome",
      intervalMs: workerConfig.signalOutcome.intervalMs,
      runOnStart: false,
      tick: async () => {
        const prisma = getPrisma();
        const open = await prisma.signalHistory.findMany({
          where: { outcome: "OPEN", type: { not: "HOLD" } },
          orderBy: { generatedAt: "asc" },
          take: workerConfig.signalOutcome.batchSize,
          select: {
            id: true,
            symbol: true,
            type: true,
            entry: true,
            stopLoss: true,
            target: true,
            generatedAt: true,
          },
        });
        if (open.length === 0) return;

        const now = new Date();
        let resolved = 0;
        let expired = 0;
        const broker = getServerBroker();

        for (const row of open) {
          const pair = broker.pairs.spot[row.symbol as SymbolId];
          if (!pair) continue;

          let candles;
          try {
            candles = await broker.fetchKlinesRange(
              pair,
              "1m",
              row.generatedAt.getTime(),
              now.getTime(),
            );
          } catch (err) {
            log.warn("kline fetch failed", { id: row.id, err: (err as Error).message });
            continue;
          }

          const result = evaluateSignal(
            {
              type: row.type,
              entry: row.entry,
              stopLoss: row.stopLoss,
              target: row.target,
              generatedAt: row.generatedAt,
            },
            candles,
            now,
            workerConfig.signalOutcome.maxAgeMs,
          );

          if (result.outcome === "OPEN") continue;

          await prisma.signalHistory.update({
            where: { id: row.id },
            data: {
              outcome: result.outcome as SignalOutcome,
              pnlPct: result.pnlPct,
              closedAt: result.closedAt,
            },
          });
          if (result.outcome === "EXPIRED") expired += 1;
          else resolved += 1;
        }

        if (resolved > 0 || expired > 0) {
          log.info("outcome tick complete", { scanned: open.length, resolved, expired });
        }
      },
    },
    log,
  );
}
