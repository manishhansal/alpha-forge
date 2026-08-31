/**
 * Yahoo Finance provider adapter — fallback only.
 *
 * Yahoo Finance is NEVER used for live F&O trading decisions.
 * It is only appropriate for:
 *   - Long-term equity historical data (research/development)
 *   - Fallback quotes when all primary providers are unhealthy
 *
 * This adapter wraps the existing `src/services/india/yahoo` implementation
 * and is position 4 (last resort) in the priority chain.
 *
 * Capabilities:
 *   ✓ Historical NSE equity candles (no F&O)
 *   ✓ Live quotes (delayed ~15min)
 *   ✗ WebSocket feed (polling only)
 *   ✗ Option chain
 *   ✗ Instrument master
 *   ✗ OI / F&O data
 */

import type { MarketDataProvider, ProviderCallOptions } from "../provider";
import type {
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  ProviderId,
  ProviderHealth,
  SubscribeRequest,
} from "../types";
import { MarketDataError } from "../types";
import { getProviderHealth } from "../health";
import { memoCandles, memoQuote } from "../cache/market-cache";
import { finiteOrNull, toYahooSymbol } from "../normalizer";
import { filterValidCandles } from "../validation/candle-validator";

// Import from existing Yahoo adapter.
import { yahoo } from "@/services/india/yahoo";
import type { Quote as LegacyQuote } from "@/types/india";

const PROVIDER_ID: ProviderId = "yahoo";

// ── Translation helpers ───────────────────────────────────────────────────────

function translateQuote(legacy: LegacyQuote): MDQuote {
  return {
    symbol: legacy.symbol,
    token: null,
    exchange: "NSE",
    name: legacy.name ?? null,
    ltp: legacy.price,
    change: legacy.change,
    changePct: legacy.changePct,
    prevClose: legacy.prevClose ?? null,
    open: legacy.open ?? null,
    high: legacy.high ?? null,
    low: legacy.low ?? null,
    volume: legacy.volume ?? null,
    oi: null, // Yahoo doesn't provide OI
    weekHigh52: null,
    weekLow52: null,
    upperCircuit: null,
    lowerCircuit: null,
    totalBuyQty: null,
    totalSellQty: null,
    lastTradeTime: null,
    provider: PROVIDER_ID,
    fetchedAt: legacy.fetchedAt,
  };
}

// ── Provider implementation ───────────────────────────────────────────────────

export class YahooProvider implements MarketDataProvider {
  readonly id: ProviderId = PROVIDER_ID;

  async getHistoricalCandles(
    req: HistoricalCandleRequest,
    _opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    // Yahoo is not suitable for F&O instruments.
    if (req.exchange === "NFO" || req.exchange === "BFO") return [];

    // Determine range string from from/to dates.
    const fromMs = Date.parse(req.from);
    const toMs = Date.parse(req.to);
    const daysBack = Math.ceil((Date.now() - fromMs) / 86_400_000);
    const range = daysBack > 365 ? "2y" : daysBack > 180 ? "1y" : daysBack > 30 ? `${Math.ceil(daysBack / 30)}mo` : `${daysBack}d`;

    return memoCandles(
      req.symbol,
      req.exchange,
      req.interval,
      req.from,
      req.to,
      PROVIDER_ID,
      async () => {
        const legacyCandles = await yahoo.getHistorical({
          symbol: req.symbol,
          interval: req.interval as "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1w",
          range,
        });

        const ohlcv: OHLCVCandle[] = legacyCandles.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        }));

        return filterValidCandles(ohlcv);
      },
    );
  }

  async getLatestQuote(
    symbol: string,
    _opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    return memoQuote(symbol, PROVIDER_ID, async () => {
      const legacy = await yahoo.getQuote(symbol);
      if (legacy.price == null) return null;
      return translateQuote(legacy);
    });
  }

  async getQuotes(
    symbols: string[],
    _opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    if (symbols.length === 0) return [];
    const legacyQuotes = await yahoo.getQuotes(symbols);
    return legacyQuotes.map((q) => {
      if (!q || q.price == null) return null;
      return translateQuote(q);
    });
  }

  /**
   * Yahoo does not support Indian option chains.
   * Always throws so the failover engine routes to NSE/Angel.
   */
  async getOptionChain(
    underlying: string,
    _expiry?: string,
    _opts?: ProviderCallOptions,
  ): Promise<OptionChain> {
    throw new MarketDataError(
      `YahooProvider does not support option chains — use NseProvider or AngelOneProvider for ${underlying}`,
      PROVIDER_ID,
      "INVALID_RESPONSE",
    );
  }

  async getInstrumentMaster(
    _filter?: InstrumentMasterFilter,
    _opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    return [];
  }

  subscribe(
    req: SubscribeRequest,
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    const symbols = req.tokens.map((t) => t.token);
    if (!yahoo.subscribeFeed) return () => {};
    return yahoo.subscribeFeed(
      symbols,
      (q) => {
        if (q.price == null) return;
        onTick({
          token: toYahooSymbol(q.symbol),
          symbol: q.symbol,
          exchange: "NSE",
          ltp: q.price,
          change: finiteOrNull(q.change),
          changePct: finiteOrNull(q.changePct),
          volume: finiteOrNull(q.volume ?? null),
          oi: null,
          exchangeTimestampMs: Date.now(),
          receivedAtMs: Date.now(),
          provider: PROVIDER_ID,
        });
      },
      5_000,
    );
  }

  unsubscribe(_tokens: string[]): void {
    // Polling teardown handled by the function from subscribe().
  }

  getProviderHealth(): ProviderHealth {
    return getProviderHealth(PROVIDER_ID);
  }
}

// Singleton export for direct use.
export const yahooProvider = new YahooProvider();
