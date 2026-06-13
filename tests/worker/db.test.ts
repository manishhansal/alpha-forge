import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `worker/src/db.ts` wraps `@prisma/client` behind a lazy singleton. Like
 * the redis wrapper, we only cover the env-validation branch here — the
 * happy path requires a live Postgres + Prisma generated client and is
 * better exercised at integration test time.
 */
async function importDb(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import("@worker/db");
}

describe("worker/db (env validation)", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("getPrisma() throws a descriptive error when DATABASE_URL is unset", async () => {
    const { getPrisma } = await importDb({ DATABASE_URL: undefined });
    expect(() => getPrisma()).toThrow(/DATABASE_URL is not set/);
  });

  it("the error mentions the .env.example + docker:up remediation steps", async () => {
    const { getPrisma } = await importDb({ DATABASE_URL: undefined });
    expect(() => getPrisma()).toThrow(/\.env\.example.*docker:up/s);
  });

  it("closePrisma() is a safe no-op when no client has been created yet", async () => {
    const { closePrisma } = await importDb({ DATABASE_URL: undefined });
    await expect(closePrisma()).resolves.toBeUndefined();
  });
});
