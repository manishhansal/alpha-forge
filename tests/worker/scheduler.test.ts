import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scheduleJob } from "@worker/scheduler";

function silentLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

describe("worker/scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the first interval before firing when runOnStart is false", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const handle = scheduleJob(
      { name: "j", intervalMs: 1_000, tick },
      silentLogger(),
    );

    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(tick).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("fires once immediately when runOnStart is true", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const handle = scheduleJob(
      { name: "j", intervalMs: 1_000, runOnStart: true, tick },
      silentLogger(),
    );
    // The immediate tick is queued via `inFlight = runTick()` synchronously,
    // but the function body runs on the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("never overlaps two ticks: each scheduleTick awaits the previous one", async () => {
    let resolveTick: (() => void) | null = null;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const handle = scheduleJob(
      { name: "j", intervalMs: 100, runOnStart: true, tick },
      silentLogger(),
    );

    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);

    // Advance well past the interval — tick is still pending, so no second
    // call should be queued because `setTimeout(scheduleTick, ...)` is only
    // scheduled in the `finally` block after the awaited tick resolves.
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(1);

    // Resolve the in-flight tick → next setTimeout is scheduled, fires on
    // the next interval.
    resolveTick!();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(101);
    expect(tick).toHaveBeenCalledTimes(2);

    resolveTick!();
    await handle.stop();
  });

  it("logs and continues when a tick throws", async () => {
    const log = silentLogger();
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    const handle = scheduleJob(
      { name: "j", intervalMs: 50, runOnStart: true, tick },
      log,
    );

    // First tick throws → logged, but the loop schedules the next one.
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0][0]).toBe("tick threw");

    // Wait for the next interval and check the second tick fires.
    await vi.advanceTimersByTimeAsync(60);
    expect(tick).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("stop() prevents further ticks and clears the timer", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const handle = scheduleJob(
      { name: "j", intervalMs: 100, tick },
      silentLogger(),
    );

    await handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).not.toHaveBeenCalled();
  });

  it("stop() awaits an in-flight tick before resolving", async () => {
    let resolveTick: (() => void) | null = null;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const handle = scheduleJob(
      { name: "j", intervalMs: 100, runOnStart: true, tick },
      silentLogger(),
    );

    // The kick-off tick is in-flight.
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = handle.stop().then(() => {
      stopped = true;
    });

    // Stop hasn't completed yet because tick is still pending.
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveTick!();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
