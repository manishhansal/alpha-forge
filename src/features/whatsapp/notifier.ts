/**
 * WhatsApp notification dispatcher for the AlphaForge trading platform.
 *
 * Exports two async functions:
 *   - `sendEvolutionMessage` — low-level HTTP POST to the Evolution-Go API with
 *     8-second timeout, single retry on network error, and structured logging.
 *   - `dispatchWhatsApp`     — high-level dispatcher: preference check, phone
 *     lookup, Redis cooldown gate, message formatting, then delivery.
 *
 * All error paths are non-throwing. Every failure returns a typed `DispatchResult`
 * so call sites can fire-and-forget safely.
 *
 * Requirements: 1.1–1.7, 2.3, 2.4, 3.3, 4.6, 5.4, 6.3, 7.3, 8.9, 10.1–10.6
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import * as Sentry from "@sentry/node";

import { env } from "@/lib/env";
import { redis as defaultRedis, type RedisLike } from "@/lib/redis";

import { getWhatsAppPreferences, type WhatsAppEventType } from "./preferences";
import { readPhone } from "./phone";
import { formatMessage } from "./formatter";
import type { NotificationEvent } from "./types";

// ─── Public result type ───────────────────────────────────────────────────────

export interface DispatchResult {
  ok: boolean;
  status?: number;
  error?: string;
  suppressed?: boolean;
  suppressReason?: "cooldown" | "no-phone" | "event-disabled" | "not-configured";
}

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Minimal structured logger wrappers. The project doesn't expose a shared
 * logger from `src/lib/`; console.debug / console.warn match the server-side
 * log contract used by every other module in this layer.
 */
const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== "test") {
      console.debug("[whatsapp]", msg, meta ?? "");
    }
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    console.warn("[whatsapp]", msg, meta ?? "");
  },
};

// ─── Sentry helper ────────────────────────────────────────────────────────────

/**
 * Capture an error in Sentry when `SENTRY_DSN` is configured.
 * Safe to call unconditionally — no-ops when DSN is absent.
 */
function captureSentry(err: unknown): void {
  if (!env.SENTRY_DSN) return;
  try {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
  } catch {
    // observability must never throw
  }
}

// ─── Cooldown key builders ────────────────────────────────────────────────────

/**
 * Build the Redis cooldown key and TTL (seconds) for a given notification event.
 * Returns `null` when the event type has no cooldown defined (should not happen
 * in practice given the exhaustive switch).
 */
function cooldownConfig(
  event: NotificationEvent,
): { key: string; ttlSeconds: number } | null {
  switch (event.type) {
    case "DAILY_PICKS_NEW":
      return {
        key: `whatsapp:cooldown:daily-picks:${event.tradeDate}:${event.bucket}`,
        ttlSeconds: 23 * 3600,
      };
    case "AI_SIGNAL_NEW":
      return {
        key: `whatsapp:cooldown:ai-signal:${event.signal.symbol}`,
        ttlSeconds: 1800,
      };
    case "SCANNER_HIT_NEW":
      return {
        key: `whatsapp:cooldown:scanner:${event.hit.scannerType}:${event.hit.symbol}`,
        ttlSeconds: 900,
      };
    case "SIGNALS_BOARD_NEW":
      return {
        key: `whatsapp:cooldown:signals-board:${event.entry.symbol}`,
        ttlSeconds: 1200,
      };
    case "PAPER_TRADE_OPENED":
    case "PAPER_TRADE_WIN":
    case "PAPER_TRADE_LOSS":
    case "PAPER_TRADE_EXPIRED":
      return {
        key: `whatsapp:cooldown:paper-trade:${event.trade.symbol}`,
        ttlSeconds: 60,
      };
    default: {
      const _exhaustive: never = event;
      return null;
    }
  }
}

// ─── Event → preference type mapping ────────────────────────────────────────

/**
 * Map a `NotificationEventType` to the corresponding user-facing preference
 * toggle (`WhatsAppEventType`).
 *
 * PAPER_TRADE_WIN, PAPER_TRADE_LOSS, and PAPER_TRADE_EXPIRED all share the
 * single "Paper Trading" preference toggle (PAPER_TRADE_OPENED).
 *
 * Requirements: 3.3
 */
function eventToPreferenceType(type: NotificationEvent["type"]): WhatsAppEventType {
  switch (type) {
    case "DAILY_PICKS_NEW":
      return "DAILY_PICKS_NEW";
    case "AI_SIGNAL_NEW":
      return "AI_SIGNAL_NEW";
    case "SCANNER_HIT_NEW":
      return "SCANNER_HIT_NEW";
    case "SIGNALS_BOARD_NEW":
      return "SIGNALS_BOARD_NEW";
    case "PAPER_TRADE_OPENED":
    case "PAPER_TRADE_WIN":
    case "PAPER_TRADE_LOSS":
    case "PAPER_TRADE_EXPIRED":
      return "PAPER_TRADE_OPENED";
  }
}

// ─── Low-level HTTP sender ────────────────────────────────────────────────────

/**
 * Send a WhatsApp message via the Evolution-Go API.
 *
 * - POSTs to `{WHATSAPP_EVOLUTION_API_URL}/message/sendText/{WHATSAPP_INSTANCE}`
 * - Strips the leading `+` from `phone` (Evolution API expects bare digits)
 * - Includes `apikey` header when `WHATSAPP_API_KEY` is set (Requirement 1.6)
 * - 8-second AbortController timeout (Requirement 1.5)
 * - On timeout/network error: waits 2 seconds and retries once (Requirement 10.2)
 * - On non-2xx response: logs warning + returns `{ ok: false, status }` (Requirement 1.4)
 * - On success: records `whatsapp:last-dispatch` timestamp in Redis (Requirement 10.5)
 * - Captures every error in Sentry when `SENTRY_DSN` is set (Requirement 10.1)
 * - Never throws (Requirement 10.1)
 *
 * Requirements: 1.1, 1.4, 1.5, 1.6, 10.1–10.4, 10.6
 */
export async function sendEvolutionMessage(
  phone: string,
  text: string,
): Promise<DispatchResult> {
  const baseUrl = env.WHATSAPP_EVOLUTION_API_URL;
  const instance = env.WHATSAPP_INSTANCE;

  // These guards should already be checked by dispatchWhatsApp, but
  // sendEvolutionMessage is also exported for direct use (e.g. test route).
  if (!baseUrl || !instance) {
    log.warn("sendEvolutionMessage called without API URL or instance configured");
    return { ok: false, suppressed: true, suppressReason: "not-configured" };
  }

  const url = `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`;
  const body = JSON.stringify({
    number: phone.replace(/^\+/, ""),
    text,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.WHATSAPP_API_KEY) {
    headers["apikey"] = env.WHATSAPP_API_KEY;
  }

  /**
   * Attempt a single fetch with an 8-second AbortController timeout.
   * Returns the fetch Response on success, or throws on timeout / network error.
   */
  async function attempt(): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Core dispatch logic: try once, retry on network/timeout failure.
   * Returns a DispatchResult; never throws.
   */
  async function send(isRetry: boolean): Promise<DispatchResult> {
    const attemptLabel = isRetry ? "retry" : "attempt 1";
    try {
      const res = await attempt();

      if (!res.ok) {
        // Non-2xx — log warning with status + body, capture in Sentry.
        const bodyText = await res.text().catch(() => "");
        log.warn(`Evolution API non-2xx (${attemptLabel})`, {
          status: res.status,
          body: bodyText.slice(0, 500),
          phone: phone.slice(0, 6) + "…",
        });
        captureSentry(
          new Error(`Evolution API ${res.status}: ${bodyText.slice(0, 200)}`),
        );
        return { ok: false, status: res.status };
      }

      // Success — record last-dispatch timestamp in Redis (best-effort).
      log.debug(`Evolution API success (${attemptLabel})`, {
        status: res.status,
        phone: phone.slice(0, 6) + "…",
      });
      try {
        await defaultRedis.set("whatsapp:last-dispatch", new Date().toISOString());
      } catch (redisErr) {
        log.debug("Failed to update whatsapp:last-dispatch", {
          err: (redisErr as Error).message,
        });
      }

      return { ok: true, status: res.status };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log.debug(`Evolution API error (${attemptLabel})`, { err: message });

      if (!isRetry) {
        // Wait 2 seconds then retry once (Requirement 10.2).
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return send(true);
      }

      // Retry also failed — log warning and capture in Sentry.
      log.warn("Evolution API failed after retry", {
        err: message,
        phone: phone.slice(0, 6) + "…",
      });
      captureSentry(err);
      return { ok: false, error: message };
    }
  }

  return send(false);
}

// ─── High-level dispatcher ────────────────────────────────────────────────────

/**
 * Primary WhatsApp notification entry point.
 *
 * Orchestrates the full dispatch pipeline:
 *   1. Guard — check `WHATSAPP_EVOLUTION_API_URL` and `WHATSAPP_INSTANCE` are set.
 *   2. Preferences — map event type to preference toggle, check if enabled.
 *   3. Phone — read + decrypt the user's stored phone number.
 *   4. Cooldown — atomic Redis gate; bypass gracefully if Redis is unavailable.
 *   5. Format — build the message string with the appropriate formatter.
 *   6. Send — call `sendEvolutionMessage` and return its result.
 *
 * All errors are caught internally. The function never throws.
 *
 * Requirements: 1.2, 1.3, 2.3, 2.4, 3.3, 4.6, 5.4, 6.3, 7.3, 8.9, 10.3
 */
export async function dispatchWhatsApp(
  event: NotificationEvent,
  userId: string,
  deps?: { redis?: RedisLike; prisma?: PrismaClient },
): Promise<DispatchResult> {
  try {
    // ── Step 1: Configuration guard ────────────────────────────────────────
    if (!env.WHATSAPP_EVOLUTION_API_URL || !env.WHATSAPP_INSTANCE) {
      log.warn("WhatsApp dispatch skipped — WHATSAPP_EVOLUTION_API_URL or WHATSAPP_INSTANCE not set", {
        event: event.type,
        userId,
      });
      return { ok: false, suppressed: true, suppressReason: "not-configured" };
    }

    // ── Step 2: Preference check ───────────────────────────────────────────
    const prefs = await getWhatsAppPreferences(userId, deps?.prisma);
    const preferenceKey = eventToPreferenceType(event.type);
    if (!prefs.enabledEvents.includes(preferenceKey)) {
      log.debug("WhatsApp dispatch suppressed — event type disabled by user", {
        event: event.type,
        preferenceKey,
        userId,
      });
      return { ok: false, suppressed: true, suppressReason: "event-disabled" };
    }

    // ── Step 3: Phone number lookup ────────────────────────────────────────
    const phone = await readPhone(userId, deps?.prisma);
    if (!phone) {
      log.debug("WhatsApp dispatch suppressed — no phone configured for user", { userId });
      return { ok: false, suppressed: true, suppressReason: "no-phone" };
    }

    // ── Step 4: Redis cooldown gate ────────────────────────────────────────
    const cooldown = cooldownConfig(event);
    if (cooldown) {
      const redisClient = deps?.redis ?? defaultRedis;
      let cooldownBypassed = false;

      try {
        const existing = await redisClient.get(cooldown.key);
        if (existing !== null) {
          // Key is present — cooldown active, suppress this dispatch.
          return { ok: false, suppressed: true, suppressReason: "cooldown" };
        }
        // Reserve the cooldown key before dispatching to prevent races.
        await redisClient.set(cooldown.key, "1", "EX", cooldown.ttlSeconds);
      } catch (redisErr) {
        // Redis unavailable — bypass cooldown (best-effort). Log and continue.
        cooldownBypassed = true;
        log.debug("Redis cooldown check failed — bypassing (best-effort)", {
          key: cooldown.key,
          err: (redisErr as Error).message,
        });
      }

      if (!cooldownBypassed) {
        log.debug("Cooldown key set", { key: cooldown.key, ttl: cooldown.ttlSeconds });
      }
    }

    // ── Step 5: Format the message ─────────────────────────────────────────
    const message = formatMessage(event);

    // ── Step 6: Send via Evolution API ────────────────────────────────────
    return await sendEvolutionMessage(phone, message);
  } catch (err) {
    // Catch-all: log, capture in Sentry, return failed result — never throw.
    const message = (err as Error).message ?? String(err);
    log.warn("dispatchWhatsApp unexpected error", { err: message, event: event.type, userId });
    captureSentry(err);
    return { ok: false, error: message };
  }
}
