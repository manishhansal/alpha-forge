"use client";

import { env } from "@/lib/env";

export interface LiquidationEvent {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  notionalUsd: number;
  ts: number;
}

interface RawForceOrder {
  e: "forceOrder";
  E: number;
  o: {
    s: string;
    S: "BUY" | "SELL";
    q: string;
    p: string;
    ap: string;
    T: number;
  };
}

interface RawStreamMessage {
  stream: string;
  data: RawForceOrder;
}

type Listener = (event: LiquidationEvent) => void;

export type LiquidationConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

interface ClientOptions {
  symbols?: string[];
  onLiquidation: Listener;
  onStatusChange?: (status: LiquidationConnectionStatus) => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class BinanceLiquidationWsClient {
  private socket: WebSocket | null = null;
  private status: LiquidationConnectionStatus = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionallyClosed = false;
  private readonly symbolFilter: Set<string> | null;

  constructor(private readonly opts: ClientOptions) {
    this.symbolFilter = opts.symbols && opts.symbols.length > 0 ? new Set(opts.symbols) : null;
  }

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
    const base = env.NEXT_PUBLIC_BINANCE_FUTURES_WS;
    const url = `${base}?streams=!forceOrder@arr`;

    this.setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error("[binance-liq-ws] failed to construct socket:", err);
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
        const order = msg?.data?.o;
        if (!order) return;
        if (this.symbolFilter && !this.symbolFilter.has(order.s)) return;
        const qty = Number(order.q);
        const price = Number(order.ap || order.p);
        this.opts.onLiquidation({
          symbol: order.s,
          side: order.S,
          qty,
          price,
          notionalUsd: qty * price,
          ts: order.T,
        });
      } catch (err) {
        console.warn("[binance-liq-ws] message parse failed:", err);
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

  private setStatus(status: LiquidationConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status);
  }
}
