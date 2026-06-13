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

  strategyLab: {
    intervalMs: Number(process.env.WORKER_STRATEGY_LAB_INTERVAL_MS ?? 60_000),
  },
} as const;

export type WorkerConfig = typeof workerConfig;
