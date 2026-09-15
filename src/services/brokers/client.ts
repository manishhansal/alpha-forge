"use client";
/**
 * src/services/brokers/client.ts
 *
 * Browser-side market data stream client — now backed by data-service2.0.
 *
 * After the data-service2.0 centralization, all live market data (including
 * crypto tickers and liquidations) flows through data-service2.0's WebSocket
 * stream rather than directly from Binance or Delta Exchange.
 *
 * The public interface is preserved so consumers don't break.
 */
import { TRACKED_SYMBOLS } from "@/lib/constants";
import type { SymbolId } from "@/types/market";
import type {
  BrokerCapabilities,
  BrokerId,
  BrokerPairs,
  BrokerStreamClient,
  LiquidationStreamOptions,
  TickerStreamOptions,
} from "./types";

export interface ClientBroker {
  readonly id: BrokerId;
  readonly displayName: string;
  readonly pairs: BrokerPairs;
  readonly capabilities: BrokerCapabilities;
  createTickerStream(opts: TickerStreamOptions): BrokerStreamClient;
  createLiquidationStream(opts: LiquidationStreamOptions): BrokerStreamClient;
}

function buildPairs(): BrokerPairs {
  const spot: Record<SymbolId, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };
  const futures: Record<SymbolId, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };
  for (const sym of TRACKED_SYMBOLS) {
    spot[sym.id] = sym.id === "BTC" ? "BTCUSDT" : sym.id === "ETH" ? "ETHUSDT" : "SOLUSDT";
    futures[sym.id] = spot[sym.id]!;
  }
  return { spot, futures };
}

/**
 * Build the authenticated WebSocket URL for data-service2.0.
 *
 * Browsers cannot send custom request headers during the WebSocket handshake,
 * so the API key is passed as the `api_key` query parameter instead.
 * NEXT_PUBLIC_DATA_SERVICE_API_KEY is the browser-safe, public env var.
 */
function buildWsUrl(): string {
  const dsUrl = (
    process.env.NEXT_PUBLIC_DATA_SERVICE_2_URL ??
    process.env.NEXT_PUBLIC_DATA_SERVICE_URL ??
    "http://localhost:8200"
  ).replace(/^http/, "ws");
  const base = `${dsUrl}/v1/stream/ticks`;
  const apiKey = process.env.NEXT_PUBLIC_DATA_SERVICE_API_KEY;
  return apiKey ? `${base}?api_key=${encodeURIComponent(apiKey)}` : base;
}

// Reconnect backoff constants
const RECONNECT_BASE_MS  = 1_000;
const RECONNECT_MAX_MS   = 30_000;
const RECONNECT_EXPONENT = 2;

/**
 * Creates a data-service2.0-backed ticker stream with automatic exponential-
 * backoff reconnection.
 *
 * Backoff schedule: 1s → 2s → 4s → 8s → 16s → 30s (capped), then repeats.
 * The delay resets to 1s after a successful open. The status sequence is:
 *   idle → connecting → open → (on close) connecting → open → …
 */
function createDataServiceTickerStream(opts: TickerStreamOptions): BrokerStreamClient {
  const wsUrl = buildWsUrl();
  let ws:           WebSocket | null = null;
  let closed        = false;       // true once disconnect() is called — stops all retries
  let retryDelay    = RECONNECT_BASE_MS;
  let retryTimer:   ReturnType<typeof setTimeout> | null = null;

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function connect() {
    if (closed) return;
    opts.onStatusChange?.("connecting");

    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // WebSocket constructor itself threw (unsupported env, bad URL, etc.)
      opts.onStatusChange?.("error");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (closed) { ws?.close(1000, "client disconnect"); return; }
      retryDelay = RECONNECT_BASE_MS; // reset backoff on successful connect
      opts.onStatusChange?.("open");
      ws?.send(JSON.stringify({ action: "subscribe", symbols: opts.pairs, market: "crypto" }));
    };

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const tick = JSON.parse(event.data as string);
        if (tick.symbol && tick.ltp !== undefined) {
          opts.onTicker?.({
            pair:        tick.symbol,
            close:       Number(tick.ltp),
            open:        Number(tick.open  ?? tick.ltp),
            high:        Number(tick.high  ?? tick.ltp),
            low:         Number(tick.low   ?? tick.ltp),
            volume:      tick.volume      ?? 0,
            quoteVolume: tick.tradedValue ?? 0,
            eventTime:   tick.timestamp ? new Date(tick.timestamp as string).getTime() : Date.now(),
          });
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      // onerror always precedes onclose — no need to emit status here;
      // onclose will fire next and trigger the reconnect.
    };

    ws.onclose = () => {
      if (closed) return;
      opts.onStatusChange?.("connecting"); // show "Connecting…" while backing off
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelay);
    // Exponential backoff: double delay, cap at max
    retryDelay = Math.min(retryDelay * RECONNECT_EXPONENT, RECONNECT_MAX_MS);
  }

  return {
    connect() {
      closed = false;
      retryDelay = RECONNECT_BASE_MS;
      connect();
    },
    disconnect() {
      closed = true;
      clearRetryTimer();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "unsubscribe", symbols: opts.pairs }));
          ws.close(1000, "client disconnect");
        }
        ws = null;
      }
      opts.onStatusChange?.("closed");
    },
  };
}

/**
 * Creates a data-service2.0-backed liquidation stream with exponential-backoff
 * reconnection (shares the same constants as the ticker stream).
 */
function createDataServiceLiquidationStream(opts: LiquidationStreamOptions): BrokerStreamClient {
  const wsUrl = buildWsUrl();
  let ws:        WebSocket | null = null;
  let closed     = false;
  let retryDelay = RECONNECT_BASE_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRetryTimer() {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      opts.onStatusChange?.("error");
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      if (closed) { ws?.close(1000, "client disconnect"); return; }
      retryDelay = RECONNECT_BASE_MS;
      ws?.send(JSON.stringify({ action: "subscribe", symbols: opts.pairs, market: "crypto", type: "liquidation" }));
    };
    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "liquidation" || data.liquidation) {
          opts.onLiquidation?.({
            pair:        data.symbol ?? "",
            side:        data.side   ?? "BUY",
            price:       data.price  ?? 0,
            qty:         data.qty    ?? 0,
            notionalUsd: (data.qty ?? 0) * (data.price ?? 0),
            ts:          data.timestamp ? new Date(data.timestamp as string).getTime() : Date.now(),
          });
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = () => { /* onclose fires after onerror — reconnect handled there */ };
    ws.onclose = () => {
      if (closed) return;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearRetryTimer();
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
    retryDelay = Math.min(retryDelay * RECONNECT_EXPONENT, RECONNECT_MAX_MS);
  }

  return {
    connect() {
      closed = false;
      retryDelay = RECONNECT_BASE_MS;
      connect();
    },
    disconnect() {
      closed = true;
      clearRetryTimer();
      ws?.close(1000, "client disconnect");
      ws = null;
    },
  };
}

const DATA_SERVICE_BROKER: ClientBroker = {
  id: "binance" as BrokerId, // kept for backward compat — actual source is data-service2.0
  displayName: "Market Data (via data-service2.0)",
  pairs: buildPairs(),
  capabilities: {
    spotTicker: true,
    futuresTicker: true,
    liquidations: true,
    klines: true,
  },
  createTickerStream: createDataServiceTickerStream,
  createLiquidationStream: createDataServiceLiquidationStream,
};

export function getClientBroker(_id?: BrokerId): ClientBroker {
  return DATA_SERVICE_BROKER;
}

export function getActiveBroker(): ClientBroker {
  return DATA_SERVICE_BROKER;
}

export { DATA_SERVICE_BROKER as clientBroker };
