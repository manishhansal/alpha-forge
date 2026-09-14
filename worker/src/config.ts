/**
 * worker/src/config.ts
 *
 * Worker configuration.
 *
 * After the data-service2.0 centralization:
 *   - All market data is served by data-service2.0 (not Binance/Delta directly)
 *   - No direct broker WebSocket connections in the worker
 *   - Liquidations are proxied through data-service2.0
 */
import type { BrokerId } from "@/services/brokers/types";

/**
 * Worker config. All values are sourced from env at boot.
 */
export const workerConfig = {
  env: (process.env.NODE_ENV ?? "development") as "development" | "test" | "production",

  /** Active broker ID (kept for interface compat — market data comes from data-service2.0) */
  broker: "binance" as BrokerId,

  /** data-service2.0 connection */
  dataService: {
    url: process.env.DATA_SERVICE_2_URL ?? process.env.DATA_SERVICE_URL ?? "http://localhost:8200",
    apiKey: process.env.DATA_SERVICE_API_KEY,
    wsUrl: (process.env.DATA_SERVICE_2_URL ?? process.env.DATA_SERVICE_URL ?? "http://localhost:8200")
      .replace(/^http/, "ws"),
  },

  liquidations: {
    symbols: (() => {
      const raw = process.env.WORKER_LIQUIDATION_SYMBOLS ?? "";
      const parsed = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      return parsed.length > 0 ? parsed : ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    })(),
    // Liquidations come from data-service2.0, not direct Binance WS
    wsUrl: (process.env.DATA_SERVICE_2_URL ?? process.env.DATA_SERVICE_URL ?? "http://localhost:8200")
      .replace(/^http/, "ws") + "/v1/stream/ticks",
    supported: true, // data-service2.0 always supports this
    bufferRetentionMs: 15 * 60 * 1000,
    pruneIntervalMs: 60_000,
    reconnect: { baseMs: 1_000, maxMs: 30_000 },
    heartbeatMs: 30_000,
  },

  signalIngest: {
    intervalMs: Number(process.env.WORKER_SIGNAL_INGEST_INTERVAL_MS ?? 60_000),
    appBaseUrl:
      process.env.WORKER_APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  },

  signalOutcome: {
    intervalMs: Number(process.env.WORKER_SIGNAL_OUTCOME_INTERVAL_MS ?? 5 * 60_000),
    maxAgeMs: 24 * 60 * 60 * 1000,
    batchSize: 50,
  },

  alerts: {
    intervalMs: Number(process.env.WORKER_ALERTS_INTERVAL_MS ?? 30_000),
  },

  scalper: {
    intervalMs: Number(process.env.WORKER_SCALPER_INTERVAL_MS ?? 30_000),
  },

  indiaScalper: {
    intervalMs: Number(process.env.WORKER_INDIA_SCALPER_INTERVAL_MS ?? 60_000),
  },

  indiaOptionChainCapture: {
    intervalMs: Number(process.env.WORKER_INDIA_OC_CAPTURE_INTERVAL_MS ?? 5 * 60_000),
  },

  indiaDailyPicks: {
    intervalMs: Number(process.env.WORKER_INDIA_DAILY_PICKS_INTERVAL_MS ?? 60_000),
  },

  strategyLab: {
    intervalMs: Number(process.env.WORKER_STRATEGY_LAB_INTERVAL_MS ?? 60_000),
  },

  indiaScanner: {
    intervalMs: Number(process.env.WORKER_INDIA_SCANNER_INTERVAL_MS ?? 5 * 60_000),
  },

  whatsapp: {
    enabled: Boolean(
      process.env.WHATSAPP_EVOLUTION_API_URL && process.env.WHATSAPP_INSTANCE,
    ),
  },

  /**
   * Tick listener — subscribes to data-service2.0 Redis pub/sub channels.
   * Enabled when DATA_SERVICE_2_URL or DATA_SERVICE_URL is set.
   */
  scrapingTicks: {
    enabled: Boolean(
      process.env.DATA_SERVICE_2_URL ??
      process.env.DATA_SERVICE_URL ??
      process.env.SCRAPING_TICK_LISTEN === "true",
    ),
  },
} as const;

export type WorkerConfig = typeof workerConfig;
