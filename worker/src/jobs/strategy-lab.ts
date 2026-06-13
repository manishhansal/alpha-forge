import { tickActiveStrategies } from "@/features/strategy-lab/paper-trader";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:strategy-lab");

/**
 * Worker job that drives live forward-testing of every Strategy with
 * `liveEnabled = true`.
 *
 * Each tick: pulls fresh closed candles, evaluates the entry rule on the
 * latest bar to detect a freshly-fired signal, dedupes against existing
 * OPEN trades, then walks 1m candles for any open positions to resolve
 * stops/targets/expiry.
 */
export function startStrategyLabJob(): JobHandle {
  return scheduleJob(
    {
      name: "strategy-lab",
      intervalMs: workerConfig.strategyLab.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");
        const prisma = getPrisma();
        try {
          const stats = await tickActiveStrategies(prisma);
          if (stats.scanned > 0 && (stats.opened > 0 || stats.closed > 0 || stats.errors > 0)) {
            child.info("tick", stats);
          }
        } catch (err) {
          child.warn("tick failed", { err: (err as Error).message });
        }
      },
    },
    log,
  );
}
