/**
 * Angel One SmartAPI WebSocket 2.0 ("SmartStream") binary feed.
 *
 * The stream pushes little-endian binary frames (LTP / Quote / SnapQuote modes)
 * over a single socket — replacing the 1 req/s FULL-quote poll the gateway used
 * to drive the SSE feed. This module is split into a **pure** protocol layer
 * (frame parser + subscribe-message builder, fully unit-tested) and a thin
 * `SmartStreamClient` that owns the `ws` connection, heartbeat and reconnect.
 *
 * Binary layout (offsets in bytes, little-endian) per the SmartStream v2 spec:
 *   0       int8    subscription mode (1 LTP · 2 Quote · 3 SnapQuote)
 *   1       int8    exchange type
 *   2..26   char25  token (null-terminated ASCII)
 *   27..34  int64   sequence number
 *   35..42  int64   exchange timestamp (ms)
 *   43..50  int64   last traded price (paisa)              ── LTP frame ends @51
 *   51..58  int64   last traded quantity
 *   59..66  int64   average traded price (paisa)
 *   67..74  int64   volume traded today
 *   75..82  float64 total buy quantity
 *   83..90  float64 total sell quantity
 *   91..98  int64   open (paisa)
 *   99..106 int64   high (paisa)
 *   107..114 int64  low (paisa)
 *   115..122 int64  close / prev-close (paisa)             ── Quote frame ends @123
 *   123..130 int64  last traded timestamp
 *   131..138 int64  open interest
 *   ... best-five depth (200B) ...
 *   347..354 int64  upper circuit (paisa)
 *   355..362 int64  lower circuit (paisa)
 *   363..370 int64  52-week high (paisa)
 *   371..378 int64  52-week low (paisa)                    ── SnapQuote frame ends @379
 */

import WebSocket from "ws";

export const SMART_STREAM_URL =
  "wss://smartapisocket.angelone.in/smart-stream";

export const SMART_MODE = {
  LTP: 1,
  QUOTE: 2,
  SNAPQUOTE: 3,
} as const;

/** SmartStream exchange-type codes used in subscribe payloads + frame byte 1. */
export const SMART_EXCHANGE_TYPE = {
  NSE_CM: 1,
  NSE_FO: 2,
  BSE_CM: 3,
  BSE_FO: 4,
  MCX_FO: 5,
  NCX_FO: 7,
  CDE_FO: 13,
} as const;

export type SmartTick = {
  mode: number;
  exchangeType: number;
  token: string;
  sequence: number;
  exchangeTimestamp: number;
  ltp: number;
  lastTradedQty?: number;
  avgTradedPrice?: number;
  volume?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  oi?: number;
  upperCircuit?: number;
  lowerCircuit?: number;
  weekHigh52?: number;
  weekLow52?: number;
};

const LTP_FRAME_BYTES = 51;
const QUOTE_FRAME_BYTES = 123;
const SNAPQUOTE_FRAME_BYTES = 379;

function toUint8(input: ArrayBuffer | Uint8Array | Buffer): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

/**
 * Decode a single SmartStream binary frame. Prices are converted from paisa to
 * rupees (÷100). Returns `null` for frames too short to even carry the LTP
 * header (e.g. a stray `pong` control frame).
 */
export function parseSmartTick(
  input: ArrayBuffer | Uint8Array | Buffer,
): SmartTick | null {
  const u8 = toUint8(input);
  if (u8.byteLength < LTP_FRAME_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  let token = "";
  for (let i = 2; i < 27; i++) {
    const c = u8[i];
    if (c === 0) break;
    token += String.fromCharCode(c);
  }

  const i64 = (off: number): number => Number(dv.getBigInt64(off, true));
  const f64 = (off: number): number => dv.getFloat64(off, true);
  const price = (off: number): number => i64(off) / 100;

  const tick: SmartTick = {
    mode: dv.getInt8(0),
    exchangeType: dv.getInt8(1),
    token,
    sequence: i64(27),
    exchangeTimestamp: i64(35),
    ltp: price(43),
  };

  if (tick.mode === SMART_MODE.LTP || u8.byteLength < QUOTE_FRAME_BYTES) {
    return tick;
  }

  tick.lastTradedQty = i64(51);
  tick.avgTradedPrice = price(59);
  tick.volume = i64(67);
  tick.totalBuyQty = f64(75);
  tick.totalSellQty = f64(83);
  tick.open = price(91);
  tick.high = price(99);
  tick.low = price(107);
  tick.close = price(115);

  if (tick.mode !== SMART_MODE.SNAPQUOTE || u8.byteLength < SNAPQUOTE_FRAME_BYTES) {
    return tick;
  }

  tick.oi = i64(131);
  tick.upperCircuit = price(347);
  tick.lowerCircuit = price(355);
  tick.weekHigh52 = price(363);
  tick.weekLow52 = price(371);
  return tick;
}

/** Percent change of `ltp` vs the previous `close`. Null when close ≤ 0. */
export function changePctFromTick(
  ltp: number,
  close: number | null | undefined,
): number | null {
  if (close == null || close <= 0) return null;
  return ((ltp - close) / close) * 100;
}

export type SmartSubscribeMessage = {
  correlationID: string;
  /** 1 = subscribe, 0 = unsubscribe. */
  action: number;
  params: {
    mode: number;
    tokenList: { exchangeType: number; tokens: string[] }[];
  };
};

/** Build a SmartStream subscribe/unsubscribe JSON payload. */
export function buildSubscribeMessage(args: {
  tokensByExchangeType: Record<number, string[]>;
  mode: number;
  action?: number;
  correlationID?: string;
}): SmartSubscribeMessage {
  const tokenList = Object.entries(args.tokensByExchangeType)
    .map(([ex, tokens]) => ({ exchangeType: Number(ex), tokens }))
    .filter((b) => b.tokens.length > 0);
  return {
    correlationID: args.correlationID ?? "alphaforge",
    action: args.action ?? 1,
    params: { mode: args.mode, tokenList },
  };
}

export type SmartStreamCredentials = {
  apiKey: string;
  clientCode: string;
  jwt: string;
  feedToken: string;
};

export type SmartStreamClientOptions = {
  credentials: SmartStreamCredentials;
  tokensByExchangeType: Record<number, string[]>;
  mode?: number;
  onTick: (tick: SmartTick) => void;
  onError?: (err: unknown) => void;
  /** Heartbeat cadence (Angel drops idle sockets ~every 30s). */
  heartbeatMs?: number;
  /** Auto-reconnect on close. Default true. */
  reconnect?: boolean;
};

/**
 * Thin SmartStream socket wrapper. Construction is side-effect free; call
 * {@link start} to connect. Frame decoding is delegated to {@link parseSmartTick}
 * so the protocol logic stays pure + testable via {@link handleMessage}.
 */
export class SmartStreamClient {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempts = 0;

  constructor(private readonly opts: SmartStreamClientOptions) {}

  start(): void {
    if (this.stopped || this.ws) return;
    const { credentials } = this.opts;
    const ws = new WebSocket(SMART_STREAM_URL, {
      headers: {
        Authorization: credentials.jwt,
        "x-api-key": credentials.apiKey,
        "x-client-code": credentials.clientCode,
        "x-feed-token": credentials.feedToken,
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      this.subscribe();
      this.startHeartbeat();
    });
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("error", (err) => this.opts.onError?.(err));
    ws.on("close", () => {
      this.stopHeartbeat();
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  /** Decode an incoming frame and emit a tick. Text/control frames are ignored. */
  handleMessage(data: unknown): void {
    if (typeof data === "string") return;
    let u8: Uint8Array | null = null;
    if (data instanceof Uint8Array) u8 = data;
    else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (Array.isArray(data)) u8 = Buffer.concat(data as Buffer[]);
    if (!u8) return;
    const tick = parseSmartTick(u8);
    if (tick) this.opts.onTick(tick);
  }

  private subscribe(): void {
    if (!this.ws) return;
    const msg = buildSubscribeMessage({
      tokensByExchangeType: this.opts.tokensByExchangeType,
      mode: this.opts.mode ?? SMART_MODE.QUOTE,
    });
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const everyMs = this.opts.heartbeatMs ?? 25_000;
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send("ping");
      } catch {
        /* socket closing — the close handler will reconnect */
      }
    }, everyMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.opts.reconnect === false) return;
    this.attempts += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts, 5));
    this.reconnectTimer = setTimeout(() => this.start(), backoff);
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
