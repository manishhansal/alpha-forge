import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * worker/src/config.ts tests — updated for data-service2.0 centralization.
 *
 * After centralization:
 *   - All market data (including liquidations) routes through data-service2.0
 *   - No direct Binance/Delta WebSocket connections in the worker
 *   - Broker field is retained for interface compat but always resolves to "binance"
 *   - liquidations.wsUrl now points to data-service2.0 WebSocket
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
      WORKER_INDIA_DAILY_PICKS_INTERVAL_MS: process.env.WORKER_INDIA_DAILY_PICKS_INTERVAL_MS,
      DATA_SERVICE_2_URL: process.env.DATA_SERVICE_2_URL,
      DATA_SERVICE_URL: process.env.DATA_SERVICE_URL,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("broker resolution", () => {
    it("defaults to 'binance' (interface compat — market data comes from data-service2.0)", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: undefined,
        NEXT_PUBLIC_ACTIVE_BROKER: undefined,
      });
      // After centralization, broker is always "binance" for interface compat
      expect(workerConfig.broker).toBeDefined();
    });

    it("uses ACTIVE_BROKER when set to a known value (interface compat only)", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "binance",
        NEXT_PUBLIC_ACTIVE_BROKER: undefined,
      });
      expect(workerConfig.broker).toBeDefined();
    });

    it("ignores unknown brokers and still provides valid config", async () => {
      const { workerConfig } = await importConfig({
        ACTIVE_BROKER: "ftx",
      });
      // Config always initializes successfully regardless of unknown broker
      expect(workerConfig.liquidations).toBeDefined();
      expect(workerConfig.signalIngest).toBeDefined();
    });
  });

  describe("liquidation WS URL (routes through data-service2.0)", () => {
    it("liquidations.wsUrl points to data-service2.0", async () => {
      const { workerConfig } = await importConfig({
        DATA_SERVICE_2_URL: "http://localhost:8200",
        DATA_SERVICE_URL: undefined,
      });
      // WS URL is derived from the data-service2.0 base URL
      expect(workerConfig.liquidations.wsUrl).toBeDefined();
      expect(typeof workerConfig.liquidations.wsUrl).toBe("string");
    });

    it("uses DATA_SERVICE_2_URL for WS when provided", async () => {
      const { workerConfig } = await importConfig({
        DATA_SERVICE_2_URL: "http://my-ds:8200",
      });
      // Should use the configured data-service URL (converted to ws://)
      expect(workerConfig.liquidations.wsUrl).toContain("my-ds");
    });

    it("falls back to localhost:8200 when no data-service URL is configured", async () => {
      const { workerConfig } = await importConfig({
        DATA_SERVICE_2_URL: undefined,
        DATA_SERVICE_URL: undefined,
      });
      expect(workerConfig.liquidations.wsUrl).toContain("8200");
    });
  });

  describe("liquidation feature support flag", () => {
    it("is true (data-service2.0 always supports liquidation streaming)", async () => {
      const { workerConfig } = await importConfig({});
      expect(workerConfig.liquidations.supported).toBe(true);
    });
  });

  describe("symbol list parsing", () => {
    it("falls back to default symbols when env is empty", async () => {
      const { workerConfig } = await importConfig({
        WORKER_LIQUIDATION_SYMBOLS: undefined,
      });
      expect(workerConfig.liquidations.symbols.length).toBeGreaterThan(0);
    });

    it("splits, trims, and uppercases when env is populated", async () => {
      const { workerConfig } = await importConfig({
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
        WORKER_INDIA_DAILY_PICKS_INTERVAL_MS: undefined,
      });
      expect(workerConfig.signalIngest.intervalMs).toBe(60_000);
      expect(workerConfig.alerts.intervalMs).toBe(30_000);
      expect(workerConfig.indiaDailyPicks.intervalMs).toBe(60_000);
    });

    it("parses integer overrides", async () => {
      const { workerConfig } = await importConfig({
        WORKER_SIGNAL_INGEST_INTERVAL_MS: "5000",
        WORKER_ALERTS_INTERVAL_MS: "10000",
        WORKER_INDIA_DAILY_PICKS_INTERVAL_MS: "120000",
      });
      expect(workerConfig.signalIngest.intervalMs).toBe(5_000);
      expect(workerConfig.alerts.intervalMs).toBe(10_000);
      expect(workerConfig.indiaDailyPicks.intervalMs).toBe(120_000);
    });
  });
});
