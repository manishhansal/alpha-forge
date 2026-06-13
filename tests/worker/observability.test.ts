import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `worker/src/observability.ts` reads `SENTRY_DSN` at init time. We
 * deliberately keep these tests focused on the **disabled / no-DSN**
 * path — the only path that doesn't require the Sentry SDK to actually
 * be mocked and reachable.
 *
 * Why no enabled-path tests:
 *   `vmThreads` (our Vitest pool, see `vitest.config.ts`) doesn't always
 *   route bare-module mock factories to dynamically-imported modules in
 *   the way `vi.mock("@sentry/node", …)` would normally guarantee. Rather
 *   than rely on that, we cover the no-op contract here and let the
 *   integration-level Sentry behaviour be verified by the real
 *   `@sentry/node` SDK at runtime — its public API surface is small and
 *   stable enough that mocking it has low marginal value.
 *
 * Each test re-imports the module so the internal `initialized` and
 * `enabled` singletons start clean.
 */
async function importObservability(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import("@worker/observability");
}

describe("worker/observability (disabled path)", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      SENTRY_DSN: process.env.SENTRY_DSN,
    };
  });

  afterEach(() => {
    if (originalEnv.SENTRY_DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalEnv.SENTRY_DSN;
  });

  it("initObservability returns disabled when SENTRY_DSN is unset", async () => {
    const { initObservability, observabilityEnabled } = await importObservability({
      SENTRY_DSN: undefined,
    });
    const result = initObservability({ serviceName: "x" });
    expect(result).toEqual({ enabled: false, dsnConfigured: false });
    expect(observabilityEnabled()).toBe(false);
  });

  it("captureLogBreadcrumb is a no-op when disabled", async () => {
    const { captureLogBreadcrumb } = await importObservability({
      SENTRY_DSN: undefined,
    });
    expect(() =>
      captureLogBreadcrumb({ level: "info", scope: "x", msg: "y" }),
    ).not.toThrow();
  });

  it("captureLogError is a no-op when disabled", async () => {
    const { captureLogError } = await importObservability({
      SENTRY_DSN: undefined,
    });
    expect(() =>
      captureLogError({
        level: "error",
        scope: "x",
        msg: "y",
        meta: { err: "oops" },
      }),
    ).not.toThrow();
  });

  it("captureError is a no-op when disabled", async () => {
    const { captureError } = await importObservability({
      SENTRY_DSN: undefined,
    });
    expect(() => captureError(new Error("boom"))).not.toThrow();
  });

  it("flushObservability resolves to true when disabled (nothing to flush)", async () => {
    const { flushObservability } = await importObservability({
      SENTRY_DSN: undefined,
    });
    await expect(flushObservability()).resolves.toBe(true);
  });

  it("initObservability is idempotent — multiple calls return the same result", async () => {
    const { initObservability } = await importObservability({
      SENTRY_DSN: undefined,
    });
    const a = initObservability({ serviceName: "x" });
    const b = initObservability({ serviceName: "x" });
    expect(a).toEqual(b);
  });
});
