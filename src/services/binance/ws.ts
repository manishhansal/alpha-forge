"use client";

import { env } from "@/lib/env";

export interface BinanceMiniTicker {
  symbol: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  eventTime: number;
}

interface RawMiniTickerPayload {
  e: string;
  E: number;
  s: string;
  c: string;
  o: string;
  h: string;
  l: string;
  v: string;
  q: string;
}

interface RawStreamMessage {
  stream: string;
  data: RawMiniTickerPayload;
}

type Listener = (ticker: BinanceMiniTicker) => void;

interface ClientOptions {
  symbols: string[];
  onTicker: Listener;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class BinanceWsClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionallyClosed = false;

  constructor(private readonly opts: ClientOptions) {}

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.intentionallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.close(1000, "client disconnect");
      this.socket = null;
    }
    this.setStatus("closed");
  }

  private openSocket(): void {
    const streams = this.opts.symbols
      .map((s) => `${s.toLowerCase()}@miniTicker`)
      .join("/");
    const url = `${env.NEXT_PUBLIC_BINANCE_WS}?streams=${streams}`;

    this.setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error("[binance-ws] failed to construct socket:", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.setStatus("open");
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string) as RawStreamMessage;
        if (!msg?.data) return;
        const d = msg.data;
        this.opts.onTicker({
          symbol: d.s,
          close: Number(d.c),
          open: Number(d.o),
          high: Number(d.h),
          low: Number(d.l),
          volume: Number(d.v),
          quoteVolume: Number(d.q),
          eventTime: d.E,
        });
      } catch (err) {
        console.warn("[binance-ws] message parse failed:", err);
      }
    });

    socket.addEventListener("error", () => {
      this.setStatus("error");
    });

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

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const jitter = Math.random() * 250;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1)) + jitter;
    this.setStatus("closed");
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ method: "PING" }));
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
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
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status);
  }
}
