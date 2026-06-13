import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both spy targets are captured via `vi.hoisted` so the `vi.mock` factory
// can refer to them safely.
const { breadcrumbSpy, errorSpy } = vi.hoisted(() => ({
  breadcrumbSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock("@worker/observability", () => ({
  captureLogBreadcrumb: (...args: unknown[]) => breadcrumbSpy(...args),
  captureLogError: (...args: unknown[]) => errorSpy(...args),
}));

/**
 * `worker/src/log.ts` reads `WORKER_LOG_LEVEL`, `WORKER_LOG_FORMAT`,
 * `WORKER_SERVICE_NAME`, and `NODE_ENV` at import time. Re-import after
 * each env mutation by clearing Vitest's module cache.
 */
async function importLog(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import("@worker/log");
}

describe("worker/log", () => {
  let originalEnv: Record<string, string | undefined>;
  let consoleSpies: {
    debug: ReturnType<typeof vi.spyOn>;
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    originalEnv = {
      WORKER_LOG_LEVEL: process.env.WORKER_LOG_LEVEL,
      WORKER_LOG_FORMAT: process.env.WORKER_LOG_FORMAT,
      WORKER_SERVICE_NAME: process.env.WORKER_SERVICE_NAME,
      NODE_ENV: process.env.NODE_ENV,
    };
    consoleSpies = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    breadcrumbSpy.mockReset();
    errorSpy.mockReset();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    consoleSpies.debug.mockRestore();
    consoleSpies.log.mockRestore();
    consoleSpies.warn.mockRestore();
    consoleSpies.error.mockRestore();
  });

  describe("level filtering", () => {
    it("emits debug+ when WORKER_LOG_LEVEL=debug", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "debug",
        WORKER_LOG_FORMAT: "pretty",
      });
      const log = createLogger("test");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
      expect(consoleSpies.debug).toHaveBeenCalledTimes(1);
      expect(consoleSpies.log).toHaveBeenCalledTimes(1);
      expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpies.error).toHaveBeenCalledTimes(1);
    });

    it("suppresses debug when WORKER_LOG_LEVEL=info", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "info",
        WORKER_LOG_FORMAT: "pretty",
      });
      const log = createLogger("test");
      log.debug("d");
      log.info("i");
      expect(consoleSpies.debug).not.toHaveBeenCalled();
      expect(consoleSpies.log).toHaveBeenCalledTimes(1);
    });

    it("treats empty WORKER_LOG_LEVEL as 'unset' and falls back to the default", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "",
        NODE_ENV: "development",
        WORKER_LOG_FORMAT: "pretty",
      });
      const log = createLogger("test");
      log.debug("hi"); // dev default = debug
      expect(consoleSpies.debug).toHaveBeenCalledTimes(1);
    });

    it("uses 'info' as the default when NODE_ENV=production", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: undefined,
        NODE_ENV: "production",
        WORKER_LOG_FORMAT: "pretty",
      });
      const log = createLogger("test");
      log.debug("hidden");
      log.info("shown");
      expect(consoleSpies.debug).not.toHaveBeenCalled();
      expect(consoleSpies.log).toHaveBeenCalledTimes(1);
    });
  });

  describe("output format", () => {
    it("emits a single-line pretty record by default in dev", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "info",
        WORKER_LOG_FORMAT: "pretty",
      });
      createLogger("scope").info("hello", { user: 7 });
      expect(consoleSpies.log).toHaveBeenCalledOnce();
      const line = consoleSpies.log.mock.calls[0][0] as string;
      expect(line).toMatch(/INFO\s+\[scope]\s+hello/);
      expect(line).toMatch(/"user":7/);
    });

    it("emits JSON when WORKER_LOG_FORMAT=json", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "info",
        WORKER_LOG_FORMAT: "json",
        WORKER_SERVICE_NAME: "tester",
        NODE_ENV: "production",
      });
      createLogger("scope").info("hi", { ok: true });
      const line = consoleSpies.log.mock.calls[0][0] as string;
      const obj = JSON.parse(line);
      expect(obj).toMatchObject({
        level: "info",
        service: "tester",
        env: "production",
        scope: "scope",
        msg: "hi",
        meta: { ok: true },
      });
      expect(typeof obj.ts).toBe("string");
    });
  });

  describe("child scopes", () => {
    it("prefixes the parent scope to every emitted line", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "info",
        WORKER_LOG_FORMAT: "pretty",
      });
      const parent = createLogger("worker");
      parent.child("redis").info("hi");
      const line = consoleSpies.log.mock.calls[0][0] as string;
      expect(line).toContain("[worker:redis]");
    });
  });

  describe("observability fan-out", () => {
    it("forwards non-error logs as breadcrumbs", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "debug",
        WORKER_LOG_FORMAT: "pretty",
      });
      createLogger("scope").info("hi", { foo: 1 });
      expect(breadcrumbSpy).toHaveBeenCalledOnce();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("forwards error logs as Sentry events", async () => {
      const { createLogger } = await importLog({
        WORKER_LOG_LEVEL: "debug",
        WORKER_LOG_FORMAT: "pretty",
      });
      createLogger("scope").error("boom", { err: "msg" });
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(breadcrumbSpy).not.toHaveBeenCalled();
    });
  });
});
