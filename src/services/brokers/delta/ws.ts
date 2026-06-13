"use client";

import { env } from "@/lib/env";

import type {
  BrokerStreamClient,
  ConnectionStatus,
  LiquidationStreamOptions,
  TickerStreamOptions,
} from "../types";

const HEARTBEAT_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/* ────────────────── Delta ticker payload shapes ────────────────── */

/**
 * The compact `ticker` channel payload (Delta's new public socket schema).
 * Fields we care about:
 *   - `sy` symbol, `ts` micro timestamp
 *   - `d[0].ohlc` 24h open/high/low/close
 *   - `to[0]` USD turnover (24h)
 */
interface CompactTickerEntry {
  s?: string; // symbol (some payloads put it inside `d[]`)
  ohlc?: [number, number, number, number];
  to?: [number, number]; // [turnover, turnover_usd]
}

interface CompactTickerEnvelope {
  type: "ticker";
  sy?: string;
  sp?: string; // spot price
  ts?: number; // microseconds
  d?: CompactTickerEntry[];
}

/**
 * The legacy `v2/ticker` payload still works against the new socket. We
 * accept either shape to remain robust through the Delta migration that
 * deprecates the old channel on 31-Jul-2026.
 */
interface LegacyTickerPayload {
  type: "v2/ticker" | "ticker";
  symbol?: string;
  close?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  mark_price?: string;
  spot_price?: string;
  turnover_usd?: number | string;
  volume?: number | string;
  timestamp?: number;
}

type AnyTickerMessage = CompactTickerEnvelope | LegacyTickerPayload | { type: string };

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}

function microToMs(microOrSec: number | undefined): number {
  if (!microOrSec || !Number.isFinite(microOrSec)) return Date.now();
  if (microOrSec > 1e14) return Math.floor(microOrSec / 1000);
  if (microOrSec > 1e11) return microOrSec;
  return microOrSec * 1000;
}

/* ────────────────── shared WS plumbing ────────────────── */

interface SubscribePayload {
  channelName: string;
  symbols: string[];
}

interface DeltaSocketOptions {
  subscribe: SubscribePayload[];
  onMessage: (msg: AnyTickerMessage) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

class DeltaPublicSocket {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  constructor(private readonly opts: DeltaSocketOptions) {}

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.intentionallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.clearTimers();
    if (this.socket) {
      try {
        this.socket.close(1000, "client disconnect");
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.setStatus("closed");
  }

  private openSocket(): void {
    const url = env.NEXT_PUBLIC_DELTA_WS;
    this.setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error("[delta-ws] failed to construct socket:", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.setStatus("open");
      this.subscribe();
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string) as AnyTickerMessage;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "pong" || msg.type === "heartbeat") {
          // Clear the pong watchdog — server is alive.
          if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
          }
          return;
        }
        this.opts.onMessage(msg);
      } catch (err) {
        console.warn("[delta-ws] message parse failed:", err);
      }
    });

    socket.addEventListener("error", () => this.setStatus("error"));

    socket.addEventListener("close", () => {
      this.clearTimers();
      this.socket = null;
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      } else {
        this.setStatus("closed");
      }
    });
  }

  private subscribe(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const sub of this.opts.subscribe) {
      this.socket.send(
        JSON.stringify({
          type: "subscribe",
          payload: {
            channels: [{ name: sub.channelName, symbols: sub.symbols }],
          },
        }),
      );
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      try {
        this.socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        return;
      }
      // Delta's contract: if no pong within 5s, treat the connection as dead.
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        try {
          this.socket?.close(4000, "pong timeout");
        } catch {
          // ignore
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const jitter = Math.random() * 250;
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1)) + jitter;
    this.setStatus("closed");
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status);
  }
}

/* ────────────────── public factories ────────────────── */

/**
 * Browser ticker stream backed by Delta's `ticker` public channel (replaces
 * the legacy `v2/ticker`; both schemas are handled below for robustness).
 *
 * Delta publishes 24h OHLC every ~5 s rather than per-trade tick updates, so
 * the visible "live" feed will tick slower than Binance's miniTicker. We map
 * each update onto our `BrokerMiniTicker` shape so the store doesn't care.
 */
export function createDeltaTickerStream(opts: TickerStreamOptions): BrokerStreamClient {
  // Per-pair quote-volume / volume snapshot so we can synthesize a
  // `BrokerMiniTicker` even when the compact payload omits some fields.
  const lastByPair = new Map<
    string,
    { open: number; high: number; low: number; close: number; volume: number; quote: number }
  >();

  const socket = new DeltaPublicSocket({
    subscribe: [{ channelName: "ticker", symbols: opts.pairs }],
    onStatusChange: opts.onStatusChange,
    onMessage: (msg) => {
      if (!msg) return;
      // Compact form: `type: "ticker"`, `sy`, `d[]` with `ohlc`/`to`.
      if ("d" in msg && Array.isArray((msg as CompactTickerEnvelope).d)) {
        const env = msg as CompactTickerEnvelope;
        const pair = env.sy;
        if (!pair) return;
        const entry = env.d?.[0];
        if (!entry) return;
        const ohlc = entry.ohlc ?? [0, 0, 0, 0];
        const to = entry.to ?? [0, 0];
        const snapshot = {
          open: ohlc[0] ?? 0,
          high: ohlc[1] ?? 0,
          low: ohlc[2] ?? 0,
          close: ohlc[3] ?? 0,
          volume: 0,
          quote: to[1] ?? to[0] ?? 0,
        };
        lastByPair.set(pair, snapshot);
        opts.onTicker({
          pair,
          close: snapshot.close,
          open: snapshot.open,
          high: snapshot.high,
          low: snapshot.low,
          volume: snapshot.volume,
          quoteVolume: snapshot.quote,
          eventTime: microToMs(env.ts),
        });
        return;
      }
      // Legacy form: `type: "v2/ticker"` with named fields.
      if (msg.type === "v2/ticker" || msg.type === "ticker") {
        const m = msg as LegacyTickerPayload;
        const pair = m.symbol;
        if (!pair) return;
        const close = num(m.close ?? m.mark_price);
        const open = num(m.open);
        const high = num(m.high);
        const low = num(m.low);
        opts.onTicker({
          pair,
          close,
          open: open || close,
          high: high || close,
          low: low || close,
          volume: num(m.volume),
          quoteVolume: num(m.turnover_usd),
          eventTime: microToMs(m.timestamp),
        });
      }
    },
  });

  return {
    connect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
  };
}

/**
 * Delta India doesn't publish a public liquidations channel — only
 * authenticated `liquidations` notifications on the private channel, which
 * are scoped to the connected account. We return a no-op stream that
 * immediately reports `unavailable` so the UI can render a "stream offline"
 * badge instead of waiting forever.
 */
export function createDeltaLiquidationStream(
  opts: LiquidationStreamOptions,
): BrokerStreamClient {
  let reported = false;
  return {
    connect: () => {
      if (reported) return;
      reported = true;
      opts.onStatusChange?.("unavailable");
    },
    disconnect: () => {
      reported = false;
    },
  };
}
