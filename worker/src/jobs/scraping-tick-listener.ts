/**
 * Subscribes to af:ticks:* Redis pub/sub channels published by the
 * data-service Scrapling tick publisher. Normalises each message to a
 * LiveTick and forwards it to the onTick callback — the same pipeline
 * used by Angel One SmartStream.
 *
 * Activation: set DATA_SERVICE_URL (or SCRAPING_TICK_LISTEN=true).
 * The job uses workerConfig.scrapingTicks.enabled as the gate.
 *
 * Reconnection: on Redis connection error the listener waits
 * RECONNECT_BASE_MS (doubled each attempt, capped at RECONNECT_CAP_MS)
 * then creates a fresh subscriber client and re-subscribes. This means
 * a brief Redis blip no longer kills the tick stream permanently.
 */

import type { Redis } from "ioredis";

import type { LiveTick } from "@/lib/market-data/types";

import { workerConfig } from "../config";
import { createLogger } from "../log";
import { createSubscriberClient } from "../redis";

const log = createLogger("worker:scraping-tick-listener");

const RECONNECT_BASE_MS = 1_000;   // 1 s initial backoff
const RECONNECT_CAP_MS  = 30_000;  // 30 s maximum backoff

let _subscriber: Redis | null = null;
let _started = false;
let _onTickCallback: ((tick: LiveTick) => void) | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectDelay = RECONNECT_BASE_MS;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _attach(client: Redis, onTick: (tick: LiveTick) => void): void {
  client.on("error", (err: Error) => {
    log.error("[scraping-tick-listener] connection error — will reconnect", {
      err: err.message,
    });
    // Schedule a reconnect; _teardown cleans up the broken client first.
    _teardown(client);
    _scheduleReconnect(onTick);
  });

  client.psubscribe("af:ticks:*", (err, count) => {
    if (err) {
      log.error("[scraping-tick-listener] psubscribe failed", { err: err.message });
      _teardown(client);
      _scheduleReconnect(onTick);
      return;
    }
    // Successful (re)subscription — reset backoff
    _reconnectDelay = RECONNECT_BASE_MS;
    log.info("subscribed to af:ticks:*", { patternCount: count });
  });

  client.on("pmessage", (_pattern: string, channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as LiveTick;
      onTick(parsed);
    } catch (err) {
      log.warn("[scraping-tick-listener] JSON parse error", { channel, message });
    }
  });
}

function _teardown(client: Redis): void {
  try {
    client.punsubscribe("af:ticks:*");
    client.disconnect();
  } catch {
    // Best-effort cleanup — ignore errors on a broken connection
  }
  if (_subscriber === client) {
    _subscriber = null;
    _started = false;
  }
}

function _scheduleReconnect(onTick: (tick: LiveTick) => void): void {
  if (_reconnectTimer !== null) return; // already scheduled

  const delay = _reconnectDelay;
  _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_CAP_MS);

  log.info(`[scraping-tick-listener] reconnecting in ${delay}ms`);

  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!workerConfig.scrapingTicks.enabled) return; // disabled while we waited

    try {
      const client = createSubscriberClient();
      _subscriber = client;
      _started = true;
      _attach(client, onTick);
    } catch (err) {
      log.error("[scraping-tick-listener] reconnect attempt failed", {
        err: (err as Error).message,
      });
      _scheduleReconnect(onTick);
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the scraping tick listener. Subscribes to `af:ticks:*` on a
 * dedicated Redis subscriber connection and calls `onTick` for every
 * message with a valid JSON body. Safe to call multiple times — if
 * already started the second call is a no-op.
 *
 * On Redis connection loss the listener automatically reconnects with
 * exponential backoff (1 s → 2 s → 4 s … capped at 30 s).
 */
export function startScrapingTickListener(onTick: (tick: LiveTick) => void): void {
  if (!workerConfig.scrapingTicks.enabled) {
    log.info("scraping tick listener disabled — set DATA_SERVICE_URL or SCRAPING_TICK_LISTEN=true to enable");
    return;
  }

  if (_started) {
    log.warn("startScrapingTickListener called while already running — ignoring");
    return;
  }

  _onTickCallback = onTick;
  _reconnectDelay = RECONNECT_BASE_MS;

  try {
    const client = createSubscriberClient();
    _subscriber = client;
    _started = true;
    _attach(client, onTick);
    log.info("scraping tick listener started");
  } catch (err) {
    log.error("[scraping-tick-listener] initial start failed", {
      err: (err as Error).message,
    });
    _scheduleReconnect(onTick);
  }
}

/**
 * Stop the scraping tick listener and release the subscriber connection.
 * Cancels any pending reconnect timers. Idempotent — safe to call even
 * if the listener was never started.
 */
export function stopScrapingTickListener(): void {
  // Cancel any pending reconnect
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  _onTickCallback = null;

  if (!_subscriber) {
    _started = false;
    return;
  }

  _teardown(_subscriber);
  log.info("scraping tick listener stopped");
}
