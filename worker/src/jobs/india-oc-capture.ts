import { captureOptionChainSnapshots } from "@/features/india/scalping/option-chain-capture";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

import { workerConfig } from "../config";
import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-oc-capture");

// ── RCA-002 fix: OC capture health monitoring ─────────────────────────────────
// Alert when no snapshot has been captured for more than OC_STALENESS_ALERT_MS
// during market hours. This detects the 12:51–15:30 gap observed on 2026-09-01.

/** Maximum acceptable gap between OC snapshots during market hours (15 minutes). */
const OC_STALENESS_ALERT_MS = 15 * 60_000;
/** Redis key tracking the last successful OC snapshot epoch ms. */
const OC_LAST_CAPTURE_KEY = "india:oc-capture:last-success-ms";

/**
 * Record a successful snapshot capture to Redis so the staleness guard
 * can detect gaps across rapid worker restarts.
 * Best-effort — Redis unavailability must never block the capture path.
 */
async function recordOcCaptureSuccess(): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(OC_LAST_CAPTURE_KEY, String(Date.now()), "EX", 3600);
  } catch {
    // Redis unavailable — skip recording; staleness guard degrades gracefully.
  }
}

/**
 * Check whether the OC capture is stale (no successful capture in the last
 * OC_STALENESS_ALERT_MS during market hours). Emits a structured log warning
 * when stale so observability tooling (Sentry / Loki / Datadog) can alert.
 */
async function checkOcCaptureHealth(child: ReturnType<typeof log.child>): Promise<void> {
  try {
    const redis = getRedis();
    const lastMs = await redis.get(OC_LAST_CAPTURE_KEY);
    if (lastMs == null) return; // No record yet — session just started.
    const age = Date.now() - Number(lastMs);
    if (age > OC_STALENESS_ALERT_MS) {
      child.warn("oc_capture_stale", {
        lastSuccessMs: Number(lastMs),
        ageMs: age,
        thresholdMs: OC_STALENESS_ALERT_MS,
        alert: "OC snapshots have not been captured for >15 minutes during market hours. Check NSE endpoint health.",
      });
    }
  } catch {
    // Redis unavailable — skip health check silently.
  }
}

/**
 * NSE option-chain snapshot capture.
 *
 * NSE only exposes the live chain (no history API), so this job persists
 * the aggregated analytics for every F&O index on a cadence — building the
 * history that lets the option-chain strategies eventually be backtested.
 * Ticks outside the regular NSE session are skipped so we don't fill the
 * table with stale, unchanged off-hours chains.
 *
 * RCA-002 fix: staleness alert emitted when no snapshot captured in >15 min.
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

        // Health check — warn if last capture was >15 min ago.
        await checkOcCaptureHealth(child);

        try {
          const stats = await captureOptionChainSnapshots();
          if (stats.captured > 0) {
            // Record success timestamp for staleness detection.
            await recordOcCaptureSuccess();
          }
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
