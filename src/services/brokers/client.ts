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

/**
 * Creates a data-service2.0-backed ticker stream.
 * Connects to the data-service2.0 WebSocket endpoint.
 */
function createDataServiceTickerStream(opts: TickerStreamOptions): BrokerStreamClient {
  const wsUrl = buildWsUrl();
  let ws: WebSocket | null = null;
  let closed = false;

  function connect() {
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      opts.onStatusChange?.("error");
      return;
    }
    ws.onopen = () => {
      opts.onStatusChange?.("open");
      const symbols = opts.pairs.map((p) => p);
      ws?.send(JSON.stringify({ action: "subscribe", symbols, market: "crypto" }));
    };
    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const tick = JSON.parse(event.data as string);
        if (tick.symbol && tick.ltp !== undefined) {
          opts.onTicker?.({
            pair: tick.symbol,
            close: tick.ltp,
            open: tick.open ?? tick.ltp,
            high: tick.high ?? tick.ltp,
            low: tick.low ?? tick.ltp,
            volume: tick.volume ?? 0,
            quoteVolume: tick.tradedValue ?? 0,
            eventTime: tick.timestamp ? new Date(tick.timestamp).getTime() : Date.now(),
          });
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.onerror = () => opts.onStatusChange?.("error");
    ws.onclose = () => {
      if (!closed) opts.onStatusChange?.("closed");
    };
  }

  return {
    connect() {
      connect();
    },
    disconnect() {
      closed = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "unsubscribe", symbols: opts.pairs }));
        ws.close(1000, "client disconnect");
      }
      ws = null;
      opts.onStatusChange?.("closed");
    },
  };
}

/**
 * Creates a data-service2.0-backed liquidation stream.
 * Liquidation data comes from data-service2.0's crypto stream.
 */
function createDataServiceLiquidationStream(opts: LiquidationStreamOptions): BrokerStreamClient {
  const wsUrl = buildWsUrl();
  let ws: WebSocket | null = null;
  let closed = false;

  return {
    connect() {
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          ws?.send(JSON.stringify({ action: "subscribe", symbols: opts.pairs, market: "crypto", type: "liquidation" }));
        };
        ws.onmessage = (event) => {
          if (closed) return;
          try {
            const data = JSON.parse(event.data as string);
            if (data.type === "liquidation" || data.liquidation) {
              opts.onLiquidation?.({
                pair: data.symbol ?? "",
                side: data.side ?? "BUY",
                price: data.price ?? 0,
                qty: data.qty ?? 0,
                notionalUsd: (data.qty ?? 0) * (data.price ?? 0),
                ts: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
              });
            }
          } catch {
            // ignore
          }
        };
        ws.onerror = () => opts.onStatusChange?.("error");
        ws.onclose = () => {
          if (!closed) opts.onStatusChange?.("closed");
        };
      } catch {
        opts.onStatusChange?.("error");
      }
    },
    disconnect() {
      closed = true;
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
