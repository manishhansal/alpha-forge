import type { Logger } from "./log";

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  /** Whether to invoke the tick once on startup before waiting for the first interval. */
  runOnStart?: boolean;
  tick: () => Promise<void>;
}

export interface JobHandle {
  name: string;
  stop: () => Promise<void>;
}

/**
 * Run a single recurring tick. We use setTimeout (not setInterval) so that
 * each tick fully awaits the previous one — never two overlapping evaluations
 * of the same alert. A failing tick logs and continues; the loop never throws.
 */
export function scheduleJob(job: ScheduledJob, log: Logger): JobHandle {
  const child = log.child(job.name);
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const runTick = async () => {
    if (stopped) return;
    const started = Date.now();
    try {
      await job.tick();
      child.debug("tick complete", { elapsedMs: Date.now() - started });
    } catch (err) {
      child.error("tick threw", {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(scheduleTick, job.intervalMs);
      }
    }
  };

  const scheduleTick = () => {
    inFlight = runTick();
  };

  if (job.runOnStart) {
    scheduleTick();
  } else {
    timer = setTimeout(scheduleTick, job.intervalMs);
  }

  child.info(`scheduled every ${job.intervalMs}ms${job.runOnStart ? " (immediate)" : ""}`);

  return {
    name: job.name,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await inFlight;
      } catch {
        // already logged
      }
      child.info("stopped");
    },
  };
}
