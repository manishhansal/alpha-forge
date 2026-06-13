import WebSocket from "ws";

import {
  LIQUIDATION_BUFFER_TTL_SECONDS,
  REDIS_KEYS,
} from "@/lib/constants";
import type { BufferedLiquidationEvent } from "@/features/futures/liquidations";

import { workerConfig } from "../config";
import { createLogger } from "../log";
import { getRedis } from "../redis";

const log = createLogger("worker:liquidations");

interface RawForceOrder {
  e?: "forceOrder";
  E?: number;
  o?: {
    s: string;
    S: "BUY" | "SELL";
    q: string;
    p: string;
    ap: string;
    T: number;
  };
}

interface RawStreamEnvelope {
  stream?: string;
  data?: RawForceOrder;
}

interface SubscriberState {
  socket: WebSocket | null;
  intentionallyClosed: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  pruneTimer: NodeJS.Timeout | null;
}

const state: SubscriberState = {
  socket: null,
  intentionallyClosed: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  heartbeatTimer: null,
  pruneTimer: null,
};

function buildUrl(): string {
  const base = workerConfig.liquidations.wsUrl;
  // `!forceOrder@arr` streams all liquidations; we filter client-side by symbol
  // since the per-symbol stream caps at 1 event per second per symbol.
  return `${base}?streams=!forceOrder@arr`;
}

const symbolFilter = new Set(workerConfig.liquidations.symbols);

async function handleForceOrder(raw: RawForceOrder): Promise<void> {
  const order = raw?.o;
  if (!order) return;
  if (!symbolFilter.has(order.s)) return;

  const qty = Number(order.q);
  const price = Number(order.ap || order.p);
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) {
    log.debug("dropping malformed force order", { s: order.s, q: order.q, p: order.p });
    return;
  }
  const ts = Number(order.T);
  if (!Number.isFinite(ts) || ts <= 0) {
    log.debug("dropping force order with bad timestamp", { s: order.s, T: order.T });
    return;
  }

  const event: BufferedLiquidationEvent = {
    side: order.S,
    qty,
    price,
    notionalUsd: qty * price,
    ts,
  };
  const key = REDIS_KEYS.liquidationBuffer(order.s);
  const redis = getRedis();
  try {
    await redis.zadd(key, ts, JSON.stringify(event));
    await redis.expire(key, LIQUIDATION_BUFFER_TTL_SECONDS);
  } catch (err) {
    log.warn("redis write failed", { err: (err as Error).message, key });
  }
}

async function prune(): Promise<void> {
  const cutoff = Date.now() - workerConfig.liquidations.bufferRetentionMs;
  const redis = getRedis();
  for (const sym of symbolFilter) {
    const key = REDIS_KEYS.liquidationBuffer(sym);
    try {
      const removed = await redis.zremRangeByScore(key, "-inf", cutoff);
      if (removed > 0) log.debug("pruned", { key, removed });
    } catch (err) {
      log.warn("prune failed", { err: (err as Error).message, key });
    }
  }
}

function clearTimers(): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (state.intentionallyClosed) return;
  state.reconnectAttempts += 1;
  const { baseMs, maxMs } = workerConfig.liquidations.reconnect;
  const jitter = Math.random() * 500;
  const delay = Math.min(maxMs, baseMs * 2 ** (state.reconnectAttempts - 1)) + jitter;
  log.warn("scheduling reconnect", { attempt: state.reconnectAttempts, delayMs: Math.round(delay) });
  state.reconnectTimer = setTimeout(connect, delay);
}

function startHeartbeat(): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      try {
        state.socket.ping();
      } catch (err) {
        log.warn("heartbeat ping failed", { err: (err as Error).message });
      }
    }
  }, workerConfig.liquidations.heartbeatMs);
}

function connect(): void {
  if (state.socket) {
    if (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING) {
      return;
    }
  }
  const url = buildUrl();
  log.info("connecting", { url, symbols: workerConfig.liquidations.symbols });
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    log.error("failed to construct socket", { err: (err as Error).message });
    scheduleReconnect();
    return;
  }
  state.socket = socket;

  socket.on("open", () => {
    state.reconnectAttempts = 0;
    log.info("connected");
    startHeartbeat();
  });

  socket.on("message", (data) => {
    let msg: RawStreamEnvelope;
    try {
      msg = JSON.parse(data.toString()) as RawStreamEnvelope;
    } catch (err) {
      log.warn("message parse failed", { err: (err as Error).message });
      return;
    }
    if (!msg.data) return;
    void handleForceOrder(msg.data);
  });

  socket.on("pong", () => {
    log.debug("pong");
  });

  socket.on("error", (err) => {
    log.warn("socket error", { err: err.message });
  });

  socket.on("close", (code, reasonBuf) => {
    const reason = reasonBuf.toString() || "(no reason)";
    log.warn("socket closed", { code, reason });
    clearTimers();
    state.socket = null;
    scheduleReconnect();
  });
}

export interface LiquidationsJobHandle {
  stop: () => Promise<void>;
}

export function startLiquidationsJob(): LiquidationsJobHandle {
  // Brokers without a public liquidation feed (Delta India today) take the
  // no-op path: the rolling buffer stays empty, callers see `null`
  // imbalance, and the signal engine drops the contribution. We log once at
  // boot so the operator knows liquidations are intentionally disabled.
  if (!workerConfig.liquidations.supported) {
    log.info("liquidations stream skipped — active broker has no public feed", {
      broker: workerConfig.broker,
    });
    return {
      stop: async () => {
        // Nothing to clean up.
      },
    };
  }

  state.intentionallyClosed = false;
  connect();
  state.pruneTimer = setInterval(() => {
    void prune();
  }, workerConfig.liquidations.pruneIntervalMs);

  return {
    stop: async () => {
      state.intentionallyClosed = true;
      clearTimers();
      if (state.pruneTimer) {
        clearInterval(state.pruneTimer);
        state.pruneTimer = null;
      }
      if (state.socket) {
        try {
          state.socket.close(1000, "worker shutdown");
        } catch {
          // ignore
        }
        state.socket = null;
      }
      log.info("stopped");
    },
  };
}
