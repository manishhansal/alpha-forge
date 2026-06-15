import { closePrisma, getPrisma } from "./db";
import { startAlertsJob } from "./jobs/alerts";
import { startLiquidationsJob, type LiquidationsJobHandle } from "./jobs/liquidations";
import { startIndiaDailyPicksJob } from "./jobs/india-daily-picks";
import { startIndiaOptionChainCaptureJob } from "./jobs/india-oc-capture";
import { startIndiaScalperJob } from "./jobs/india-scalper";
import { startScalperJob } from "./jobs/scalper";
import { startSignalIngestJob } from "./jobs/signal-ingest";
import { startSignalOutcomeJob } from "./jobs/signal-outcome";
import { startStrategyLabJob } from "./jobs/strategy-lab";
import { createLogger } from "./log";
import {
  captureError,
  flushObservability,
  initObservability,
} from "./observability";
import { closeRedis, getRedis } from "./redis";

const SERVICE_NAME = process.env.WORKER_SERVICE_NAME?.trim() || "crypto-desk-worker";

// Initialise observability before the logger emits anything that would
// otherwise be lost — Sentry breadcrumbs are best-effort and silent when DSN
// is unset, so this is safe to call unconditionally.
const observability = initObservability({ serviceName: SERVICE_NAME });

const log = createLogger("worker");

interface RunningJob {
  name: string;
  stop: () => Promise<void>;
}

const jobs: RunningJob[] = [];

async function bootstrap(): Promise<void> {
  log.info("starting worker", {
    node: process.version,
    env: process.env.NODE_ENV ?? "development",
    service: SERVICE_NAME,
    observability: observability.enabled
      ? "sentry"
      : observability.dsnConfigured
        ? "sentry-init-failed"
        : "off",
  });

  // Fail fast if Redis is unreachable — every job depends on it.
  try {
    const redis = getRedis();
    await redis.ping();
    log.info("redis ping ok");
  } catch (err) {
    log.error("redis ping failed at bootstrap", { err: (err as Error).message });
    throw err;
  }

  // Same for Prisma — log loud if the schema is out of sync.
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    log.info("prisma ping ok");
  } catch (err) {
    log.error("prisma ping failed at bootstrap", { err: (err as Error).message });
    throw err;
  }

  const liq: LiquidationsJobHandle = startLiquidationsJob();
  jobs.push({ name: "liquidations", stop: liq.stop });

  const ingest = startSignalIngestJob();
  jobs.push({ name: ingest.name, stop: ingest.stop });

  const outcome = startSignalOutcomeJob();
  jobs.push({ name: outcome.name, stop: outcome.stop });

  const alerts = startAlertsJob();
  jobs.push({ name: alerts.name, stop: alerts.stop });

  const scalper = startScalperJob();
  jobs.push({ name: scalper.name, stop: scalper.stop });

  const indiaScalper = startIndiaScalperJob();
  jobs.push({ name: indiaScalper.name, stop: indiaScalper.stop });

  const indiaOcCapture = startIndiaOptionChainCaptureJob();
  jobs.push({ name: indiaOcCapture.name, stop: indiaOcCapture.stop });

  const indiaDailyPicks = startIndiaDailyPicksJob();
  jobs.push({ name: indiaDailyPicks.name, stop: indiaDailyPicks.stop });

  const strategyLab = startStrategyLabJob();
  jobs.push({ name: strategyLab.name, stop: strategyLab.stop });

  log.info("worker ready", { jobs: jobs.map((j) => j.name) });
}

let shuttingDown = false;
async function shutdown(signal: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);

  const stopPromises = jobs.map(async (j) => {
    try {
      await j.stop();
    } catch (err) {
      log.warn(`failed to stop ${j.name}`, { err: (err as Error).message });
    }
  });
  await Promise.all(stopPromises);

  await Promise.allSettled([closeRedis(), closePrisma()]);

  // Flush queued Sentry events before we exit — otherwise SIGTERM during a
  // crash loop would drop the most useful event of the lifecycle.
  await flushObservability(2000);

  log.info("shutdown complete");
  // Give logs a tick to flush.
  setTimeout(() => process.exit(code), 50);
}

process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err.message, stack: err.stack });
  captureError(err, { handler: "uncaughtException" });
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error("unhandledRejection", { err: err.message, stack: err.stack });
  captureError(err, { handler: "unhandledRejection" });
  void shutdown("unhandledRejection", 1);
});

bootstrap().catch((err) => {
  log.error("bootstrap failed", { err: (err as Error).message, stack: (err as Error).stack });
  captureError(err as Error, { handler: "bootstrap" });
  // Best-effort flush before exiting; can't await here without a promise wrap.
  void flushObservability(2000).finally(() => process.exit(1));
});
