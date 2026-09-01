import { ingestSignals } from "@/features/backtesting/history";
import { getSignals } from "@/features/signals/fetch-signals";
import { checkAndSetSignalGuard } from "@/lib/chaos/worker-resilience";
import { withDbRetry } from "@/lib/chaos/db-resilience";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker");

/**
 * Periodically ask the signal engine for the latest snapshot and persist new
 * actionable signals into SignalHistory (deduped against the most recent row
 * per symbol). The engine itself is cached for 30s, so we trail the cache.
 *
 * Chaos Engineering Hardening:
 *   - Scenario 10: Redis-backed signal guard prevents the same signal type
 *     for a symbol being inserted twice within a 90-second window, even on
 *     rapid worker restart.
 *   - Scenario 2: withDbRetry wraps the entire ingestSignals call so transient
 *     Postgres failures get 3 retries before the tick error-logs and continues.
 */
export function startSignalIngestJob(): JobHandle {
  return scheduleJob(
    {
      name: "signal-ingest",
      intervalMs: workerConfig.signalIngest.intervalMs,
      runOnStart: false,
      tick: async () => {
        const { signals, generatedAt } = await getSignals();
        if (signals.length === 0) return;

        // ── Chaos Scenario 10: Per-signal Redis guard ─────────────────────
        let redis: ReturnType<typeof getRedis> | undefined;
        try { redis = getRedis(); } catch { /* Redis unavailable — skip guard */ }

        const dedupedSignals = await Promise.all(
          signals.map(async (s) => {
            if (s.type === "HOLD") return s; // ingestSignals skips HOLD anyway
            if (!redis) return s;
            const isDup = await checkAndSetSignalGuard(redis, s.symbol, s.type, generatedAt);
            return isDup ? null : s;
          }),
        );
        const toIngest = dedupedSignals.filter(Boolean) as typeof signals;
        if (toIngest.length === 0) return;

        // ── Chaos Scenario 2: DB retry ─────────────────────────────────────
        const stats = await withDbRetry(
          () => ingestSignals(toIngest, getPrisma()),
          { label: "signal-ingest", maxAttempts: 3 },
        );
        if (stats.inserted > 0 || stats.skippedSameType > 0) {
          log.child("signal-ingest").debug("ingest tick", stats);
        }
      },
    },
    log,
  );
}
