import { feedBar, type IndicatorConfig, type IndicatorHandle } from "@/features/indicators";
import { getIndiaScalpSignals } from "@/features/india/scalping/fetch-signals";
import {
  getIndiaIntradayAtr,
  openIndiaPaperTrade,
  resolveIndiaOpenTrades,
} from "@/features/india/scalping/paper-trader";
import type {
  IndiaScalpStrategyId,
  IndiaScalpSignal,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";
import { dispatchWhatsApp } from "@/features/whatsapp/notifier";
import type { PaperTradeEvent, IndiaPaperTradeSnapshot } from "@/features/whatsapp/types";
import { FNO_INDICES } from "@/lib/india/fno-symbols";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";
import { getHistoricalCandlesByRange } from "@/lib/market-data/services/historical.service";
// RCA-001 fix: persist fetched intraday candles to CandleBar table for replay
import { persistCandles } from "@/lib/market-data/services/candle-persist.service";
import { bootstrapRegistry } from "@/lib/market-data/registry";
import type { OHLCVCandle } from "@/lib/market-data/types";

import { workerConfig } from "../config";
import { getPrisma } from "../db";
import {
  indicatorStateKey,
  loadIndicatorState,
  saveIndicatorState,
} from "../indicator-state";
import { createLogger } from "../log";
import { getRedis } from "../redis";
import { scheduleJob, type JobHandle } from "../scheduler";

const log = createLogger("worker:india-scalper");

/**
 * Build an `IndiaPaperTradeSnapshot` from an `IndiaScalpSignal` plus the
 * trade id returned by `openIndiaPaperTrade`. All India scalper trades are
 * NSE instruments — the exchange is hard-coded accordingly.
 *
 * Requirements: 8.1
 */
function buildOpenedSnapshot(
  sig: IndiaScalpSignal,
  tradeId: string,
): IndiaPaperTradeSnapshot {
  return {
    id: tradeId,
    symbol: sig.symbol,
    exchange: "NSE",
    direction: sig.direction,
    source: `in:${sig.strategyId}:${sig.timeframe}`,
    entry: sig.entry,
    stopLoss: sig.stopLoss,
    target: sig.target,
    riskReward: sig.riskReward,
    openedAt: sig.triggeredAt,
  };
}

/**
 * Fire-and-forget helper: emit a single `PaperTradeEvent` via the WhatsApp
 * notifier. Uses the `"system"` userId sentinel — the same convention as
 * the india-daily-picks job — because `PaperTrade` rows are system-generated
 * and not scoped to a specific user.
 *
 * Requirements: 8.1–8.4, 10.3
 */
function emitPaperTradeEvent(
  event: PaperTradeEvent,
  deps: { redis?: ReturnType<typeof getRedis>; prisma?: ReturnType<typeof getPrisma> },
): void {
  void dispatchWhatsApp(event, "system", deps).catch((err: unknown) =>
    log.warn("whatsapp paper-trade dispatch error", {
      err: (err as Error).message,
      tradeId: event.trade.id,
      symbol: event.trade.symbol,
      type: event.type,
    }),
  );
}

/**
 * Timeframes the India F&O paper-trader fans out across each tick. Same
 * lane model as the crypto scalper — one paper-trade lane per
 * (symbol × strategy × timeframe) so the journal carries the full track
 * record and the UI filters down to the lanes the user attached.
 */
const TIMEFRAMES: ReadonlyArray<IndiaScalpTimeframe> = ["1m", "5m", "15m"];

/** Default indicator configuration for India F&O indices. */
const INDICATOR_CONFIG: IndicatorConfig = {
  emaPeriod: 20,
  atrPeriod: 14,
  rsiPeriod: 14,
  bollingerPeriod: 20,
  bollingerK: 2,
};

/** NSE interval string → India yahoo interval map */
const TF_TO_INTERVAL: Record<IndiaScalpTimeframe, "1m" | "5m" | "15m"> = {
  "1m":  "1m",
  "5m":  "5m",
  "15m": "15m",
  "1d":  "5m",  // daily-based signals use 5m candles for intraday tracking
};

/**
 * Convert a canonical `OHLCVCandle` (time in seconds) to the `OHLCVBar` shape
 * expected by `feedBar`. openTime and closeTime are derived from `time`
 * (seconds, IST-aligned Unix timestamp).
 */
function candleToBar(candle: OHLCVCandle, intervalSec: number): Parameters<typeof feedBar>[1] {
  const openTimeMs = candle.time * 1000;
  return {
    openTime: openTimeMs,
    closeTime: openTimeMs + intervalSec * 1000 - 1,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
  };
}

/**
 * Feed the latest 5-min candles for an F&O index into a persisted indicator
 * handle, then save the updated state back to Redis. This ensures indicator
 * state survives worker restarts — on the next tick, the handle is restored
 * and only new bars need to be fed (warm-up in ≤ 5 bars per Requirement 1.6).
 *
 * RCA-001 fix: candles are also upserted into the CandleBar table so they
 * survive beyond the 30s Redis TTL and are available for historical replay.
 *
 * Best-effort — any error is logged and swallowed so the main trade-opening
 * logic is never blocked.
 */
async function refreshIndiaIndicatorState(
  _yahooSymbol: string,
  underlying: string,
  timeframe: IndiaScalpTimeframe,
): Promise<void> {
  try {
    await bootstrapRegistry();
    const interval = TF_TO_INTERVAL[timeframe];
    const intervalSec = interval === "1m" ? 60 : interval === "5m" ? 300 : 900;

    const candles = await getHistoricalCandlesByRange(
      underlying,
      interval,
      "5d",
      "NSE",
      { tolerateInvalidCandles: true },
    );
    if (candles.length === 0) return;

    const key = indicatorStateKey("india-scalper", underlying, timeframe);
    const handle: IndicatorHandle = await loadIndicatorState(key, INDICATOR_CONFIG);

    for (const candle of candles) {
      feedBar(handle, candleToBar(candle, intervalSec));
    }

    await saveIndicatorState(key, handle);

    // RCA-001 fix: persist candles to CandleBar so they survive Redis TTL
    // and are available for deterministic replay across sessions.
    // Fire-and-forget — persist errors are logged but never block trading.
    void persistCandles(candles, underlying, "NSE", interval).then((r) => {
      if (r.errors > 0) {
        log.warn("candle persist partial failure", {
          underlying,
          interval,
          upserted: r.upserted,
          errors: r.errors,
        });
      }
    }).catch((err: unknown) => {
      log.warn("candle persist failed", {
        underlying,
        interval,
        err: (err as Error).message,
      });
    });
  } catch (err) {
    log.warn("refreshIndiaIndicatorState failed", {
      underlying,
      timeframe,
      err: (err as Error).message,
    });
  }
}

/**
 * Two-stage tick (mirrors the crypto scalper):
 *   1. Pull the latest India signals per timeframe; size each fresh
 *      trigger off a real intraday ATR (NSE tick-rounded) and open a
 *      paper trade unless it dedupes against an OPEN lane or falls inside
 *      the expiry-day cooldown.
 *   2. Walk every OPEN India trade and resolve it against fresh 5m candles.
 *
 * ATR is fetched once per unique symbol per tick (Yahoo memoises the call)
 * so fanning out across timeframes stays cheap.
 */
export function startIndiaScalperJob(): JobHandle {
  return scheduleJob(
    {
      name: "india-scalper",
      intervalMs: workerConfig.indiaScalper.intervalMs,
      runOnStart: false,
      tick: async () => {
        const child = log.child("tick");

        // All India paper trades are intraday only — skip entirely outside
        // the NSE session (09:15–15:30 IST, Mon–Fri).
        if (!isNseMarketOpenIST(new Date())) return;

        const prisma = getPrisma();

        // Resolve Redis + Prisma clients once for the whole tick.  Both are
        // shared across all fire-and-forget WhatsApp dispatches so we only
        // pay the connection cost once.
        let redis: ReturnType<typeof getRedis> | undefined;
        try {
          redis = getRedis();
        } catch {
          // Redis unavailable — dispatchWhatsApp will bypass the cooldown
          // gate (best-effort) and continue without crashing the tick.
        }
        const whatsappDeps = { redis, prisma };

        let opened = 0;
        let dupSignal = 0;
        let alreadyOpen = 0;
        let cooldown = 0;
        const atrBySymbol = new Map<string, number | null>();
        const openedByStrategy: Partial<Record<IndiaScalpStrategyId, number>> = {};

        for (const tf of TIMEFRAMES) {
          try {
            const { signals } = await getIndiaScalpSignals({ timeframe: tf });

            // Wire streaming indicator state persistence for F&O indices.
            // Fire-and-forget so Redis errors never block trade opening.
            void Promise.allSettled(
              FNO_INDICES.map((idx) =>
                refreshIndiaIndicatorState(idx.symbol, idx.underlying, tf),
              ),
            );

            for (const sig of signals) {
              if (!atrBySymbol.has(sig.symbol)) {
                atrBySymbol.set(sig.symbol, await getIndiaIntradayAtr(sig.symbol));
              }
              const atr = atrBySymbol.get(sig.symbol) ?? undefined;

              const result = await openIndiaPaperTrade(sig, {
                prisma,
                atr: atr ?? undefined,
              });
              if (result.opened) {
                opened += 1;
                openedByStrategy[sig.strategyId] =
                  (openedByStrategy[sig.strategyId] ?? 0) + 1;

                // ── PAPER_TRADE_OPENED notification ──────────────────────
                // Only fire for `in:`-prefixed trades (all India scalper
                // trades use this prefix) when WhatsApp is configured.
                // Requirements: 8.1, 10.3
                if (workerConfig.whatsapp.enabled && result.tradeId) {
                  emitPaperTradeEvent(
                    {
                      type: "PAPER_TRADE_OPENED",
                      trade: buildOpenedSnapshot(sig, result.tradeId),
                    },
                    whatsappDeps,
                  );
                }
              } else if (result.reason === "duplicate-signal") {
                dupSignal += 1;
              } else if (result.reason === "already-open") {
                alreadyOpen += 1;
              } else if (result.reason === "expiry-cooldown") {
                cooldown += 1;
              }
            }
          } catch (err) {
            child.warn("signal fetch/open failed", {
              tf,
              err: (err as Error).message,
            });
          }
        }

        let resolveStats;
        try {
          const resolveResult = await resolveIndiaOpenTrades(prisma);
          resolveStats = resolveResult.stats;

          // ── WIN / LOSS / EXPIRED notifications ──────────────────────────
          // Emit one event per resolved trade when WhatsApp is configured.
          // Requirements: 8.2, 8.3, 8.4, 10.3
          if (workerConfig.whatsapp.enabled && resolveResult.resolved.length > 0) {
            for (const t of resolveResult.resolved) {
              const eventType =
                t.outcome === "WIN"
                  ? "PAPER_TRADE_WIN"
                  : t.outcome === "LOSS"
                    ? "PAPER_TRADE_LOSS"
                    : "PAPER_TRADE_EXPIRED";

              const snapshot: IndiaPaperTradeSnapshot = {
                id: t.id,
                symbol: t.symbol,
                exchange: t.exchange,
                direction: t.direction,
                source: t.source,
                entry: t.entry,
                stopLoss: t.stopLoss,
                target: t.target,
                riskReward: t.riskReward,
                openedAt: t.openedAt,
                exitPrice: t.exitPrice,
                pnlPct: t.pnlPct,
                resolvedAt: t.resolvedAt,
              };

              emitPaperTradeEvent(
                { type: eventType, trade: snapshot },
                whatsappDeps,
              );
            }
          }
        } catch (err) {
          child.warn("resolve failed", { err: (err as Error).message });
        }

        if (
          opened > 0 ||
          (resolveStats &&
            resolveStats.wins + resolveStats.losses + resolveStats.expired > 0)
        ) {
          child.info("tick", {
            opened,
            dupSignal,
            alreadyOpen,
            cooldown,
            byStrategy: openedByStrategy,
            ...(resolveStats ?? {}),
          });
        }
      },
    },
    log,
  );
}
