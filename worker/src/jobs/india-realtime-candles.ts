/**
 * india-realtime-candles.ts
 *
 * After the data-service2.0 centralization, AlphaForge does NOT ingest
 * live market data directly. Real-time candle construction, tick processing,
 * and live data storage are exclusively handled by data-service2.0.
 *
 * This worker job now serves as a lightweight health monitor that:
 *   1. Periodically checks data-service2.0 liveness
 *   2. Logs the status to Redis for the dashboard
 *   3. Does NOT open any direct broker WebSockets
 *   4. Does NOT write market data to the local database
 *
 * Architecture:
 *   AlphaForge worker → data-service2.0 health check → logs status
 *   (live ticks are consumed by UI via /api/in/feed/stream which proxies
 *    the data-service2.0 WebSocket)
 */
import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

const log = createLogger("worker:india-realtime-candles");

const DS_HEALTH_KEY = "india:data-service2:health";
const DS_LAST_CHECK_KEY = "india:data-service2:last-check-ms";

async function checkDataServiceHealth(): Promise<void> {
  const dataServiceUrl =
    process.env.DATA_SERVICE_2_URL ??
    process.env.DATA_SERVICE_URL ??
    "http://localhost:8200";

  const probeStart = Date.now();
  try {
    const res = await fetch(`${dataServiceUrl}/v1/health/live`, {
      signal: AbortSignal.timeout(5_000),
      headers: process.env.DATA_SERVICE_API_KEY
        ? { "X-API-KEY": process.env.DATA_SERVICE_API_KEY }
        : {},
    });

    const latencyMs = Date.now() - probeStart;
    const available = res.ok;
    const marketOpen = isNseMarketOpenIST(new Date());

    const redis = getRedis();
    await redis.set(
      DS_HEALTH_KEY,
      JSON.stringify({
        available,
        latencyMs,
        marketOpen,
        checkedAt: new Date().toISOString(),
        source: "data-service2",
      }),
      "EX",
      60,
    );
    await redis.set(DS_LAST_CHECK_KEY, probeStart.toString());

    if (!available) {
      log.warn("data-service2.0 health check failed", { status: res.status, latencyMs });
    } else {
      log.debug("data-service2.0 healthy", { latencyMs, marketOpen });
    }
  } catch (err) {
    const latencyMs = Date.now() - probeStart;
    log.warn("data-service2.0 unreachable", {
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
    });

    const redis = getRedis();
    await redis.set(
      DS_HEALTH_KEY,
      JSON.stringify({
        available: false,
        latencyMs,
        marketOpen: isNseMarketOpenIST(new Date()),
        checkedAt: new Date().toISOString(),
        source: "data-service2",
        error: "UNREACHABLE",
      }),
      "EX",
      60,
    );
  }
}

/**
 * @deprecated Use startIndiaRealtimeCandlesJob — kept for backward compat.
 */
export function startRealtimeCandlesJob(): JobHandle {
  return startIndiaRealtimeCandlesJob();
}

export function startIndiaRealtimeCandlesJob(): JobHandle {
  log.info("india-realtime-candles: monitoring data-service2.0 health (no direct broker connections)");

  // Check health every 30 seconds
  return scheduleJob(
    { name: "india-realtime-candles:health-check", intervalMs: 30_000, tick: checkDataServiceHealth },
    log,
  );
}
