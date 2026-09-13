/**
 * india-realtime-candles.ts — Data Foundation V7 §13/§14/§15/§16/§17.
 *
 * Wires the realtime market-data pipeline into the RUNNING worker (previously
 * the RealTimeCandleBuilder / MultiInstrumentCandleBuilder classes existed but
 * were never instantiated — V6 §realtime blocker):
 *
 *   token resolution → subscribeLiveFeed (Angel SmartStream → Upstox WS → poll)
 *   → tick normalization/staleness (live-feed) → MultiInstrumentCandleBuilder
 *   (dup/ordering/session/OHLC guards, Redis active-candle durability, DB upsert
 *   of confirmed bars) → realtime-vs-historical reconciliation on close →
 *   self-healing gap backfill on reconnect.
 *
 * MARKET-CLOSED HONESTY (§29/§30): the listener only subscribes during the NSE
 * session. When the market is closed it does NOT open a socket and does NOT
 * claim live verification — it logs LIVE_LISTENER_IDLE_MARKET_CLOSED and waits.
 * A tick reaching Postgres can only be asserted when the market is open.
 */

import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

const log = createLogger("worker:india-realtime-candles");

/** Redis key: last epoch ms a live tick was observed (staleness/self-heal). */
const RT_LAST_TICK_KEY = "india:realtime:last-tick-ms";
/** Redis key marking the realtime listener is currently subscribed. */
const RT_ACTIVE_KEY = "india:realtime:active";

/** Default realtime universe — indices + most-liquid F&O equities. */
const DEFAULT_RT_SYMBOLS = [
  "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
  "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN",
];

interface RealtimeState {
  subscription: { unsubscribe: () => void } | null;
  pool: import("@/lib/market-data/services/candle-builder.service").MultiInstrumentCandleBuilder | null;
  subscribedAt: number | null;
}

const state: RealtimeState = { subscription: null, pool: null, subscribedAt: null };

/** Resolve {token,exchange} for the realtime universe via the canonical instrument master. */
async function resolveTokens(
  symbols: string[],
): Promise<Array<{ token: string; exchange: "NSE" }>> {
  // Route through the canonical instrument master service instead of importing
  // Angel One ScripMaster internals directly (V9 architecture enforcement).
  const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
  await bootstrapRegistry();
  const instruments = await registry.getInstrumentMaster({
    exchange: "NSE",
    symbols,
  } as never);
  return instruments
    .filter((ins) => ins.token && ins.token !== "")
    .map((ins) => ({ token: ins.token, exchange: "NSE" as const }));
}

/** Start the live subscription + candle-builder pool (idempotent). */
async function startListener(child: ReturnType<typeof log.child>): Promise<void> {
  if (state.subscription) return; // already subscribed

  const symbols = (process.env.WORKER_REALTIME_SYMBOLS?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_RT_SYMBOLS;

  // Ensure worker credentials are loaded (provider WS needs them).
  try {
    const { loadWorkerCredentialsFromDb } = await import("@/lib/market-data/worker-credentials");
    await loadWorkerCredentialsFromDb({});
  } catch (err) {
    child.warn("credential load failed", { err: (err as Error).message });
  }

  let tokens: Array<{ token: string; exchange: "NSE" }>;
  try {
    tokens = await resolveTokens(symbols);
  } catch (err) {
    child.error("getInstrumentMaster threw — realtime listener not started this cycle", {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (tokens.length === 0) {
    child.error("getInstrumentMaster returned empty array — realtime listener not started this cycle", { symbols });
    return;
  }

  const { MultiInstrumentCandleBuilder } = await import("@/lib/market-data/services/candle-builder.service");
  const { subscribeLiveFeed } = await import("@/lib/market-data/services/live-feed.service");
  const { reconcileRealtimeVsHistorical } = await import("@/lib/market-data/services/realtime-reconciliation.service");
  const { getPrisma } = await import("../db");

  const pool = new MultiInstrumentCandleBuilder({
    persistToDb: true,
    useRedis: true,
    // §16: on each confirmed candle, reconcile against the historical row (if
    // one already exists) so realtime-vs-historical divergence is recorded.
    onEvent: (event) => {
      if (event.type !== "CANDLE_CLOSE") return;
      void (async () => {
        try {
          const prisma = getPrisma();
          const existing = await prisma.candleBar.findUnique({
            where: {
              instrumentId_exchange_intervalStr_time: {
                instrumentId: event.instrumentId,
                exchange: event.exchange,
                intervalStr: event.interval,
                time: event.candle.time,
              },
            },
            select: { close: true, provider: true },
          });
          if (existing && existing.provider && existing.provider !== "realtime") {
            await reconcileRealtimeVsHistorical({
              symbol: event.instrumentId,
              exchange: event.exchange,
              interval: event.interval,
              realtime: event.candle,
              historicalClose: existing.close,
              realtimeProvider: "realtime",
              historicalProvider: existing.provider,
              prisma,
            });
          }
        } catch {
          /* reconciliation is best-effort; never break the tick path */
        }
      })();
    },
  });

  const subscription = subscribeLiveFeed(
    tokens,
    (tick) => {
      void pool.feed(tick);
      void getRedis().set(RT_LAST_TICK_KEY, String(Date.now()), "EX", 3600).catch(() => {});
    },
    (err) => child.warn("live feed error", { err: err instanceof Error ? err.message : String(err) }),
    { mode: "quote", validateTicks: true },
  );

  state.subscription = subscription;
  state.pool = pool;
  state.subscribedAt = Date.now();
  await getRedis().set(RT_ACTIVE_KEY, "1", "EX", 3600).catch(() => {});
  child.info("realtime listener started", { instruments: tokens.length, symbols });
}

/** Stop the live subscription + close builder sessions (end of day / shutdown). */
async function stopListener(child: ReturnType<typeof log.child>): Promise<void> {
  if (state.pool) {
    try { await state.pool.closeAllSessions(); } catch (err) { child.warn("closeAllSessions failed", { err: (err as Error).message }); }
  }
  if (state.subscription) {
    try { state.subscription.unsubscribe(); } catch { /* best-effort */ }
  }
  state.subscription = null;
  state.pool = null;
  state.subscribedAt = null;
  await getRedis().del(RT_ACTIVE_KEY).catch(() => {});
  child.info("realtime listener stopped");
}

/**
 * Self-healing: after any (re)connect within a session, ask the pool to detect
 * and backfill missing interval slots from Redis-tracked last-confirmed state.
 */
async function healReconnect(child: ReturnType<typeof log.child>): Promise<void> {
  if (!state.pool) return;
  try {
    await state.pool.handleReconnect(Date.now());
  } catch (err) {
    child.warn("reconnect heal failed", { err: (err as Error).message });
  }
}

/**
 * The realtime candle job. Ticks on a short cadence to (a) start the listener
 * when the market opens, (b) stop + flush it at close, (c) run self-heal, and
 * (d) emit an idle marker when the market is closed (NO false live claim).
 */
export function startIndiaRealtimeCandlesJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-realtime-candles",
      intervalMs: 30_000,
      runOnStart: true,
      tick: async () => {
        const child = log.child("tick");
        const open = isNseMarketOpenIST(new Date());

        if (!open) {
          if (state.subscription) {
            await stopListener(child);
          } else {
            child.debug("LIVE_LISTENER_IDLE_MARKET_CLOSED");
          }
          return;
        }

        // Market open — ensure the listener is running, then self-heal.
        await startListener(child);
        await healReconnect(child);
      },
    },
    log,
  );
}
