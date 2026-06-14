import { captureOptionChainSnapshots } from "@/features/india/scalping/option-chain-capture";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

import { workerConfig } from "../config";
import { createLogger } from "../log";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-oc-capture");

/**
 * NSE option-chain snapshot capture.
 *
 * NSE only exposes the live chain (no history API), so this job persists
 * the aggregated analytics for every F&O index on a cadence — building the
 * history that lets the option-chain strategies eventually be backtested.
 * Ticks outside the regular NSE session are skipped so we don't fill the
 * table with stale, unchanged off-hours chains.
 */
export function startIndiaOptionChainCaptureJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-oc-capture",
      intervalMs: workerConfig.indiaOptionChainCapture.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");
        if (!isNseMarketOpenIST(new Date())) return;

        try {
          const stats = await captureOptionChainSnapshots();
          if (stats.captured > 0 || stats.errors > 0) {
            child.info("captured", stats);
          }
        } catch (err) {
          child.warn("capture failed", { err: (err as Error).message });
        }
      },
    },
    log,
  );
}
