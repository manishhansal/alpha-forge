/**
 * NSE direct feed provider adapter.
 *
 * Wraps the existing `src/services/india/nse` adapter behind the canonical
 * MarketDataProvider interface. NSE is position 3 in the priority chain:
 * Angel One (1) → Upstox (2) → NSE (3) → Yahoo (4).
 *
 * NSE capabilities:
 *   ✓ Option chain (index + equity) — primary strength
 *   ✓ Live quotes (via NSE market data)
 *   ✗ Historical candles — not provided; Yahoo is used for this
 *   ✗ WebSocket feed — no reliable public WSS; polling only
 *   ✗ Instrument master
 *
 * Do NOT make NSE scraping a single point of failure. Every call here must
 * fail gracefully so the failover engine can route to Yahoo when NSE is
 * rate-limited or shadow-banning this IP.
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
  OptionChainRow,
  OptionContract,
  ProviderId,
  ProviderHealth,
  SubscribeRequest,
} from "../types";
import { getProviderHealth } from "../health";
import { memoOptionChain, memoQuote } from "../cache/market-cache";
import { finiteOrNull, normaliseExpiry } from "../normalizer";

// Import the existing NSE adapter.
import { nse } from "@/services/india/nse";
import type { OptionChain as LegacyOptionChain, Quote as LegacyQuote } from "@/types/india";

const PROVIDER_ID: ProviderId = "nse";

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
    oi: legacy.oi ?? null,
    weekHigh52: legacy.weekHigh52 ?? null,
    weekLow52: legacy.weekLow52 ?? null,
    upperCircuit: legacy.upperCircuit ?? null,
    lowerCircuit: legacy.lowerCircuit ?? null,
    totalBuyQty: legacy.totalBuyQty ?? null,
    totalSellQty: legacy.totalSellQty ?? null,
    lastTradeTime: null,
    provider: PROVIDER_ID,
    fetchedAt: legacy.fetchedAt,
  };
}

function translateOptionChain(legacy: LegacyOptionChain): OptionChain {
  const rows: OptionChainRow[] = legacy.rows.map((r): OptionChainRow => {
    const makeContract = (
      leg: LegacyOptionChain["rows"][0]["ce"],
      optionType: "CE" | "PE",
    ): OptionContract | null => {
      if (!leg) return null;
      return {
        token: "",
        tradingSymbol: "",
        underlying: legacy.symbol,
        expiry: normaliseExpiry(legacy.expiry),
        strike: r.strike,
        optionType,
        ltp: finiteOrNull(leg.ltp),
        bid: finiteOrNull(leg.bid),
        ask: finiteOrNull(leg.ask),
        oi: leg.oi,
        oiChange: leg.changeInOi,
        volume: leg.volume,
        greeks: {
          iv: finiteOrNull(leg.iv),
          delta: finiteOrNull(leg.delta ?? null),
          gamma: finiteOrNull(leg.gamma ?? null),
          theta: finiteOrNull(leg.theta ?? null),
          vega: finiteOrNull(leg.vega ?? null),
          rho: null,
        },
        fetchedAt: legacy.fetchedAt,
      };
    };

    return {
      strike: r.strike,
      ce: makeContract(r.ce, "CE"),
      pe: makeContract(r.pe, "PE"),
    };
  });

  return {
    underlying: legacy.symbol,
    spot: legacy.spot,
    expiry: normaliseExpiry(legacy.expiry),
    expiries: legacy.expiries.map(normaliseExpiry),
    rows,
    analytics: {
      pcrOi: legacy.analytics.pcrOi,
      pcrVolume: legacy.analytics.pcrVolume,
      maxCeOiStrike: legacy.analytics.maxCeOiStrike,
      maxPeOiStrike: legacy.analytics.maxPeOiStrike,
      totalCeOi: legacy.analytics.totalCeOi,
      totalPeOi: legacy.analytics.totalPeOi,
      totalCeOiChange: legacy.analytics.totalCeOiChange,
      totalPeOiChange: legacy.analytics.totalPeOiChange,
      atmIv: legacy.analytics.atmIv,
      maxPain: legacy.analytics.maxPain,
    },
    provider: PROVIDER_ID,
    fetchedAt: legacy.fetchedAt,
  };
}

// ── Provider implementation ───────────────────────────────────────────────────

export class NseProvider implements MarketDataProvider {
  readonly id: ProviderId = PROVIDER_ID;

  /**
   * NSE does not provide historical candles. Always returns empty array so
   * the failover engine routes to Yahoo for historical data.
   */
  async getHistoricalCandles(
    _req: HistoricalCandleRequest,
    _opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    return [];
  }

  async getLatestQuote(
    symbol: string,
    _opts?: ProviderCallOptions,
  ): Promise<MDQuote | null> {
    return memoQuote(symbol, PROVIDER_ID, async () => {
      const [quote] = await nse.getQuotes([symbol]);
      if (!quote || quote.price == null) return null;
      return translateQuote(quote);
    });
  }

  async getQuotes(
    symbols: string[],
    _opts?: ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    if (symbols.length === 0) return [];
    const legacyQuotes = await nse.getQuotes(symbols);
    return legacyQuotes.map((q) => {
      if (!q || q.price == null) return null;
      return translateQuote(q);
    });
  }

  async getOptionChain(
    underlying: string,
    expiry?: string,
    _opts?: ProviderCallOptions,
  ): Promise<OptionChain> {
    const normExpiry = expiry ? normaliseExpiry(expiry) : "nearest";
    return memoOptionChain(underlying, normExpiry, PROVIDER_ID, async () => {
      const legacy = await nse.getOptionChain(underlying, expiry);
      return translateOptionChain(legacy);
    });
  }

  async getInstrumentMaster(
    _filter?: InstrumentMasterFilter,
    _opts?: ProviderCallOptions,
  ): Promise<Instrument[]> {
    // NSE doesn't expose a machine-readable instrument master at this layer.
    return [];
  }

  subscribe(
    req: SubscribeRequest,
    onTick: (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    // NSE doesn't have a public WebSocket feed. Poll quotes instead.
    const symbols = req.tokens.map((t) => t.token);
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const quotes = await this.getQuotes(symbols);
        for (const q of quotes) {
          if (!q || q.ltp == null) continue;
          onTick({
            token: q.symbol,
            symbol: q.symbol,
            exchange: "NSE",
            ltp: q.ltp,
            change: q.change,
            changePct: q.changePct,
            volume: q.volume,
            oi: q.oi,
            exchangeTimestampMs: Date.now(),
            receivedAtMs: Date.now(),
            provider: PROVIDER_ID,
          });
        }
      } catch (err) {
        onError?.(err);
      }
    };

    void poll();
    const id = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }

  unsubscribe(_tokens: string[]): void {
    // Polling teardown handled by the function from subscribe().
  }

  getProviderHealth(): ProviderHealth {
    return getProviderHealth(PROVIDER_ID);
  }
}

// Singleton export for direct use.
export const nseProvider = new NseProvider();
