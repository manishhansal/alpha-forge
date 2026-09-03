import { TRACKED_SYMBOLS } from "@/lib/constants";
import type { BrokerId } from "@/services/brokers/types";

function parseSymbolList(input: string | undefined, fallback: string[]): string[] {
  if (!input) return fallback;
  const list = input
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/**
 * Resolve the active broker for the worker. Falls back to
 * `NEXT_PUBLIC_ACTIVE_BROKER` so a single env line drives both layers, and
 * finally to `delta` if nothing is set.
 */
function resolveBroker(): BrokerId {
  const raw = (process.env.ACTIVE_BROKER ?? process.env.NEXT_PUBLIC_ACTIVE_BROKER ?? "delta").toLowerCase();
  if (raw === "binance" || raw === "delta") return raw;
  return "delta";
}

const ACTIVE_BROKER = resolveBroker();

/** Futures-pair strings on the active broker, for the per-symbol WS subscriber. */
const trackedFuturesPairs = TRACKED_SYMBOLS.map((s) => s.brokers[ACTIVE_BROKER].futures);

const BINANCE_FUTURES_WS = "wss://fstream.binance.com/stream";
const DELTA_PUBLIC_WS = "wss://public-socket.india.delta.exchange";

function defaultLiquidationsWsUrl(broker: BrokerId): string {
  if (broker === "binance") {
    return process.env.NEXT_PUBLIC_BINANCE_FUTURES_WS ?? BINANCE_FUTURES_WS;
  }
  return process.env.NEXT_PUBLIC_DELTA_WS ?? DELTA_PUBLIC_WS;
}

/**
 * Centralised worker config. All values are sourced from env at boot;
 * defaults are tuned so the worker is useful out of the box.
 */
export const workerConfig = {
  env: (process.env.NODE_ENV ?? "development") as "development" | "test" | "production",

  /** Currently-selected broker (drives liquidation-WS routing). */
  broker: ACTIVE_BROKER,

  liquidations: {
    /** Native futures pairs the WS subscriber filters down to. */
    symbols: parseSymbolList(process.env.WORKER_LIQUIDATION_SYMBOLS, trackedFuturesPairs),
    wsUrl: defaultLiquidationsWsUrl(ACTIVE_BROKER),
    /**
     * Capability flag: when the active broker doesn't publish a public
     * liquidation stream the job boots into a "skipped" state and the
     * rolling buffer stays empty. Computed once at boot from
     * `ACTIVE_BROKER` — restart the worker to flip it.
     */
    supported: ACTIVE_BROKER === "binance",
    /** Maximum age kept in the rolling buffer (Redis sorted set). */
    bufferRetentionMs: 15 * 60 * 1000,
    /** How often to prune entries older than retention. */
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
    /** Mark a signal `EXPIRED` if neither stop nor target hits within this window. */
    maxAgeMs: 24 * 60 * 60 * 1000,
    /** Batch size when scanning open SignalHistory rows. */
    batchSize: 50,
  },

  alerts: {
    intervalMs: Number(process.env.WORKER_ALERTS_INTERVAL_MS ?? 30_000),
  },

  scalper: {
    intervalMs: Number(process.env.WORKER_SCALPER_INTERVAL_MS ?? 30_000),
    // NOTE: the worker now fans out across every supported timeframe
    // (1m / 5m / 15m) per tick — `WORKER_SCALPER_TIMEFRAME` is intentionally
    // not read. Users attach timeframes per-strategy from the picker.
  },

  indiaScalper: {
    // India F&O paper-trader. Defaults slower than the crypto scalper —
    // the NSE option-chain + Yahoo intraday sources are heavier and the
    // signals only refresh on 5m/15m snapshots, so a 60s cadence is plenty.
    intervalMs: Number(process.env.WORKER_INDIA_SCALPER_INTERVAL_MS ?? 60_000),
  },

  indiaOptionChainCapture: {
    // NSE option-chain snapshot capture. 5-minute cadence balances history
    // resolution against NSE rate-limits; ticks outside market hours are
    // skipped by the job itself.
    intervalMs: Number(
      process.env.WORKER_INDIA_OC_CAPTURE_INTERVAL_MS ?? 5 * 60_000,
    ),
  },

  indiaDailyPicks: {
    // India F&O Daily Picks. Freezes the day's top-3-per-bucket picks on the
    // first in-session tick, then live-tracks them (P&L / progress / outcome)
    // every cadence. Ticks outside market hours are skipped by the job.
    // 1-minute cadence matches the intraday signal refresh cadence and ensures
    // TARGET_HIT / STOP_HIT are recorded within 60s of the price touching the level.
    intervalMs: Number(
      process.env.WORKER_INDIA_DAILY_PICKS_INTERVAL_MS ?? 60_000,
    ),
  },

  strategyLab: {
    intervalMs: Number(process.env.WORKER_STRATEGY_LAB_INTERVAL_MS ?? 60_000),
  },

  indiaScanner: {
    // India F&O Scanner WhatsApp notification polling.
    // 5-minute cadence is fast enough to catch intraday breakouts while
    // staying well within Yahoo / NSE rate limits. Each tick runs all six
    // scanner types in parallel and emits SCANNER_HIT_NEW events for any
    // new symbols that weren't present in the previous scan.
    intervalMs: Number(
      process.env.WORKER_INDIA_SCANNER_INTERVAL_MS ?? 5 * 60_000,
    ),
  },

  /**
   * WhatsApp notification channel (Evolution-Go gateway).
   * `enabled` is derived cheaply at boot so the worker can gate WhatsApp
   * logic without reading raw env vars in the hot path.
   */
  whatsapp: {
    enabled: Boolean(
      process.env.WHATSAPP_EVOLUTION_API_URL && process.env.WHATSAPP_INSTANCE,
    ),
  },

  /**
   * Scrapling tick listener — subscribes to `af:ticks:*` Redis pub/sub
   * channels published by the Python data-service.
   * Enabled when `DATA_SERVICE_URL` is set (data-service is reachable) or
   * when `SCRAPING_TICK_LISTEN=true` is explicitly set.
   */
  scrapingTicks: {
    enabled: Boolean(
      process.env.DATA_SERVICE_URL ||
        process.env.SCRAPING_TICK_LISTEN === "true",
    ),
  },
} as const;

export type WorkerConfig = typeof workerConfig;
