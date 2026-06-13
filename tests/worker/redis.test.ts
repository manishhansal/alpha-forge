import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `worker/src/redis.ts` is a thin singleton wrapper around `ioredis`.
 * Under the `vmThreads` Vitest pool (see `vitest.config.ts`) bare-module
 * mock factories for `ioredis` don't reliably fire for dynamically
 * imported worker modules. We avoid that brittle path entirely and just
 * cover the env-validation branch — the only behaviour that's safe to
 * exercise without standing up a real Redis server.
 */
async function importRedis(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import("@worker/redis");
}

describe("worker/redis (env validation)", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.REDIS_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
  });

  it("getRedis() throws a descriptive error when REDIS_URL is unset", async () => {
    const { getRedis } = await importRedis({ REDIS_URL: undefined });
    expect(() => getRedis()).toThrow(/REDIS_URL is not set/);
  });

  it("the error mentions the docker:up + .env.local remediation steps", async () => {
    const { getRedis } = await importRedis({ REDIS_URL: undefined });
    expect(() => getRedis()).toThrow(/docker:up.*\.env\.local/s);
  });

  it("closeRedis() is a safe no-op when no client has been created yet", async () => {
    const { closeRedis } = await importRedis({ REDIS_URL: undefined });
    await expect(closeRedis()).resolves.toBeUndefined();
  });
});
