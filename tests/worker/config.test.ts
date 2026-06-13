import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `worker/src/config.ts` reads env at import time. We re-import it after
 * each env mutation so each test sees a fresh `workerConfig` snapshot.
 */
async function importConfig(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import("@worker/config");
}

describe("worker/config", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      ACTIVE_BROKER: process.env.ACTIVE_BROKER,
      NEXT_PUBLIC_ACTIVE_BROKER: process.env.NEXT_PUBLIC_ACTIVE_BROKER,
      WORKER_LIQUIDATION_SYMBOLS: process.env.WORKER_LIQUIDATION_SYMBOLS,
      WORKER_SIGNAL_INGEST_INTERVAL_MS: process.env.WORKER_SIGNAL_INGEST_INTERVAL_MS,
      WORKER_ALERTS_INTERVAL_MS: process.env.WORKER_ALERTS_INTERVAL_MS,
      NEXT_PUBLIC_BINANCE_FUTURES_WS: process.env.NEXT_PUBLIC_BINANCE_FUTURES_WS,
      NEXT_PUBLIC_DELTA_WS: process.env.NEXT_PUBLIC_DELTA_WS,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("broker resolution", () => {
    it("defaults to delta when no broker is set", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: undefined,
        NEXT_PUBLIC_ACTIVE_BROKER: undefined,
      });
      expect(workerConfig.broker).toBe("delta");
    });

    it("uses ACTIVE_BROKER when set to a known value", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        NEXT_PUBLIC_ACTIVE_BROKER: undefined,
      });
      expect(workerConfig.broker).toBe("binance");
    });

    it("falls back to NEXT_PUBLIC_ACTIVE_BROKER when ACTIVE_BROKER is absent", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: undefined,
        NEXT_PUBLIC_ACTIVE_BROKER: "binance",
      });
      expect(workerConfig.broker).toBe("binance");
    });

    it("ignores unknown brokers and returns delta", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "ftx",
      });
      expect(workerConfig.broker).toBe("delta");
    });
  });

  describe("liquidation WS URL", () => {
    it("uses Binance default when broker=binance and no override is set", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        NEXT_PUBLIC_BINANCE_FUTURES_WS: undefined,
      });
      expect(workerConfig.liquidations.wsUrl).toMatch(/binance/i);
    });

    it("uses NEXT_PUBLIC_BINANCE_FUTURES_WS override when provided", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        NEXT_PUBLIC_BINANCE_FUTURES_WS: "wss://my.example/ws",
      });
      expect(workerConfig.liquidations.wsUrl).toBe("wss://my.example/ws");
    });

    it("uses Delta default when broker=delta and no override is set", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "delta",
        NEXT_PUBLIC_DELTA_WS: undefined,
      });
      expect(workerConfig.liquidations.wsUrl).toMatch(/delta/i);
    });
  });

  describe("liquidation feature support flag", () => {
    it("is true on binance (public force-order stream available)", async () => {
      const { workerConfig } = await importConfig({ ACTIVE_BROKER: "binance" });
      expect(workerConfig.liquidations.supported).toBe(true);
    });

    it("is false on delta (no public liquidation feed)", async () => {
      const { workerConfig } = await importConfig({ ACTIVE_BROKER: "delta" });
      expect(workerConfig.liquidations.supported).toBe(false);
    });
  });

  describe("symbol list parsing", () => {
    it("falls back to TRACKED_SYMBOLS when env is empty", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        WORKER_LIQUIDATION_SYMBOLS: undefined,
      });
      expect(workerConfig.liquidations.symbols.length).toBeGreaterThan(0);
    });

    it("splits, trims, and uppercases when env is populated", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        WORKER_LIQUIDATION_SYMBOLS: "btcusdt , ethusdt ,solusdt",
      });
      expect(workerConfig.liquidations.symbols).toEqual([
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
      ]);
    });

    it("ignores blank entries and falls back to defaults when only blanks", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        WORKER_LIQUIDATION_SYMBOLS: " , , ",
      });
      expect(workerConfig.liquidations.symbols.length).toBeGreaterThan(0);
    });
  });

  describe("interval parsing", () => {
    it("uses defaults when no env override is set", async () => {
      const { workerConfig } = await importConfig({
        WORKER_SIGNAL_INGEST_INTERVAL_MS: undefined,
        WORKER_ALERTS_INTERVAL_MS: undefined,
      });
      expect(workerConfig.signalIngest.intervalMs).toBe(60_000);
      expect(workerConfig.alerts.intervalMs).toBe(30_000);
    });

    it("parses integer overrides", async () => {
      const { workerConfig } = await importConfig({
        WORKER_SIGNAL_INGEST_INTERVAL_MS: "5000",
        WORKER_ALERTS_INTERVAL_MS: "10000",
      });
      expect(workerConfig.signalIngest.intervalMs).toBe(5_000);
      expect(workerConfig.alerts.intervalMs).toBe(10_000);
    });
  });
});
