import { ingestSignals } from "@/features/backtesting/history";
import { getSignals } from "@/features/signals/fetch-signals";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker");

/**
 * Periodically ask the signal engine for the latest snapshot and persist new
 * actionable signals into SignalHistory (deduped against the most recent row
 * per symbol). The engine itself is cached for 30s, so we trail the cache.
 */
export function startSignalIngestJob(): JobHandle {
  return scheduleJob(
    {
      name: "signal-ingest",
      intervalMs: workerConfig.signalIngest.intervalMs,
      runOnStart: false,
      tick: async () => {
        const { signals } = await getSignals();
        if (signals.length === 0) return;
        const stats = await ingestSignals(signals, getPrisma());
        if (stats.inserted > 0 || stats.skippedSameType > 0) {
          log.child("signal-ingest").debug("ingest tick", stats);
        }
      },
    },
    log,
  );
}
