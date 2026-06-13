import "server-only";

import { TRACKED_SYMBOLS } from "@/lib/constants";
import type { KlineCandle, SymbolId } from "@/types/market";
import type { KlineInterval } from "@/services/binance/klines";

import { createServerStreamStub, type ServerBrokerAdapter } from "../server-types";
import type {
  BrokerPairs,
  NormalizedFuturesTicker,
  NormalizedLongShortPoint,
  NormalizedOpenInterest,
  NormalizedOpenInterestPoint,
  NormalizedPremiumIndex,
  NormalizedTicker,
  OiPeriod,
} from "../types";

import {
  fetchAllTickers,
  fetchCandleRange,
  fetchLatestCandles,
  fetchProduct,
  fetchTickersForSymbols,
  type DeltaTicker,
} from "./rest";

const FUNDING_INTERVAL_HOURS = 8;
/** Delta India settles funding every 8 hours → annualize factor is 3*365. */
const FUNDING_PERIODS_PER_YEAR = (24 / FUNDING_INTERVAL_HOURS) * 365;

function buildPairs(): BrokerPairs {
  const spot: Record<SymbolId, string> = { BTC: "BTCUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
  const futures: Record<SymbolId, string> = { ...spot };
  for (const s of TRACKED_SYMBOLS) {
    spot[s.id] = s.brokers.delta.spot;
    futures[s.id] = s.brokers.delta.futures;
  }
  return { spot, futures };
}

const deltaPairs = buildPairs();

/* ──────────── helpers ──────────── */

function tsToMs(secOrMicroOrMs: number | undefined): number {
  if (!secOrMicroOrMs || !Number.isFinite(secOrMicroOrMs)) return Date.now();
  // Heuristic on order of magnitude:
  //   - 10^9  → unix seconds (until ~year 2286)
  //   - 10^12 → unix milliseconds
  //   - 10^15 → unix microseconds (Delta's ticker `timestamp` uses µs)
  if (secOrMicroOrMs > 1e14) return Math.floor(secOrMicroOrMs / 1000);
  if (secOrMicroOrMs > 1e11) return secOrMicroOrMs;
  return secOrMicroOrMs * 1000;
}

function normalizeTicker(t: DeltaTicker): NormalizedTicker {
  const close = t.close ?? t.mark_price ?? 0;
  const open = t.open ?? close;
  const change = close - open;
  // Delta reports `ltp_change_24h` already in percent units — `"-1.5220"`
  // means a -1.522% move over the last 24h, NOT a decimal fraction. Use it
  // as-is and only fall back to recomputing from open/close when the field
  // is missing entirely.
  const changePct =
    t.ltp_change_24h !== undefined
      ? t.ltp_change_24h
      : open > 0
        ? ((close - open) / open) * 100
        : 0;
  const high = t.high ?? close;
  const low = t.low ?? close;
  const volume = t.volume ?? 0;
  const quoteVolume = t.turnover_usd ?? t.turnover ?? 0;
  return {
    pair: t.symbol,
    price: close,
    change,
    changePct,
    high,
    low,
    volume,
    quoteVolume,
    ts: tsToMs(t.timestamp),
  };
}

/* ──────────── REST adapter methods ──────────── */

async function adaptedFetch24hrTickers(pairs: string[]): Promise<NormalizedTicker[]> {
  const tickers = await fetchTickersForSymbols(pairs);
  // Preserve request order.
  const byPair = new Map(tickers.map((t) => [t.symbol, t]));
  return pairs
    .map((p) => byPair.get(p))
    .filter((t): t is DeltaTicker => Boolean(t))
    .map(normalizeTicker);
}

async function adaptedFetchAllFuturesTickers(): Promise<NormalizedFuturesTicker[]> {
  const tickers = await fetchAllTickers({ contractTypes: ["perpetual_futures"] });
  return tickers.map<NormalizedFuturesTicker>((t) => {
    const n = normalizeTicker(t);
    return {
      pair: n.pair,
      price: n.price,
      changePct: n.changePct,
      quoteVolume: n.quoteVolume,
      ts: n.ts,
    };
  });
}

async function adaptedFetchPremiumIndex(pair: string): Promise<NormalizedPremiumIndex> {
  // The ticker carries the live mark/spot price; the product carries
  // `annualized_funding` (Delta's max-clamp value, used as a stable proxy
  // when the WS funding_rate channel isn't connected).
  const [tickerList, product] = await Promise.allSettled([
    fetchTickersForSymbols([pair]),
    fetchProduct(pair),
  ]);

  const ticker = tickerList.status === "fulfilled" ? tickerList.value[0] : undefined;
  const prod = product.status === "fulfilled" ? product.value : undefined;

  const markPrice = ticker?.mark_price ?? ticker?.close ?? 0;
  const indexPrice = ticker?.spot_price ?? markPrice;
  // Delta returns `annualized_funding` in percent (e.g. "10.95" = 10.95%).
  // Convert to a per-funding-interval fraction so callers can interpret it
  // the same way as Binance's `lastFundingRate`.
  const annualizedPct = prod?.annualized_funding ?? 0;
  const fundingRate = annualizedPct / 100 / FUNDING_PERIODS_PER_YEAR;
  const fundingRateAnnualized = (annualizedPct / 100) * 1;

  return {
    pair,
    markPrice,
    indexPrice,
    fundingRate,
    fundingRateAnnualized,
    // Delta doesn't expose next funding time in REST; UI hides it when 0.
    nextFundingTime: 0,
    ts: tsToMs(ticker?.timestamp),
  };
}

async function adaptedFetchOpenInterest(pair: string): Promise<NormalizedOpenInterest> {
  const tickers = await fetchTickersForSymbols([pair]);
  const t = tickers[0];
  return {
    pair,
    openInterest: t?.oi ?? 0,
    ts: tsToMs(t?.timestamp),
  };
}

async function adaptedFetchOpenInterestHistory(
  pair: string,
  period: OiPeriod = "5m",
  limit = 30,
): Promise<NormalizedOpenInterestPoint[]> {
  // Delta's `/v2/history/candles` accepts `OI:<symbol>` for OI in contracts.
  // We map our generic `OiPeriod` to the closest supported candle resolution.
  const resolution: KlineInterval =
    period === "5m" || period === "15m" || period === "30m" || period === "1h" || period === "2h" || period === "4h" || period === "6h" || period === "12h" || period === "1d"
      ? (period as KlineInterval)
      : "5m";
  let candles: KlineCandle[];
  try {
    candles = await fetchLatestCandles(`OI:${pair}`, resolution, limit);
  } catch {
    return [];
  }
  // For OI candles Delta reports the value in `close`. `volume` is unused.
  // notionalUsd is unavailable from this endpoint; we leave it as 0 and the
  // futures aggregator will fall back to spot price * OI when needed.
  return candles.map<NormalizedOpenInterestPoint>((c) => ({
    ts: c.closeTime,
    openInterest: c.close,
    notionalUsd: 0,
  }));
}

async function adaptedFetchLongShortRatio(): Promise<NormalizedLongShortPoint[]> {
  // Delta India does not publish a global trader long/short ratio. The
  // signal engine treats this as a missing-feature contribution. The
  // adapter interface's optional args are absorbed by structural typing.
  return [];
}

async function adaptedFetchKlines(
  pair: string,
  interval: KlineInterval,
  limit?: number,
): Promise<KlineCandle[]> {
  return fetchLatestCandles(pair, interval, limit ?? 100);
}

async function adaptedFetchKlinesRange(
  pair: string,
  interval: KlineInterval,
  startMs: number,
  endMs: number,
): Promise<KlineCandle[]> {
  return fetchCandleRange(pair, interval, startMs, endMs);
}

/* ──────────── Adapter export ──────────── */

export const deltaServerAdapter: ServerBrokerAdapter = {
  id: "delta",
  displayName: "Delta Exchange India",
  homeUrl: "https://www.delta.exchange",
  pairs: deltaPairs,
  capabilities: {
    // Delta India only exposes liquidation events on authenticated private
    // channels, never on the public socket. The liquidation rolling buffer
    // therefore stays empty when this broker is active and the signal engine
    // treats `liquidationImbalance` as missing.
    liquidations: false,
    longShortRatio: false,
    openInterestHistory: true,
  },
  fetch24hrTickers: adaptedFetch24hrTickers,
  fetchKlines: adaptedFetchKlines,
  fetchKlinesRange: adaptedFetchKlinesRange,
  fetchPremiumIndex: adaptedFetchPremiumIndex,
  fetchOpenInterest: adaptedFetchOpenInterest,
  fetchOpenInterestHistory: adaptedFetchOpenInterestHistory,
  fetchLongShortRatio: adaptedFetchLongShortRatio,
  fetchAllFuturesTickers: adaptedFetchAllFuturesTickers,
  createTickerStream: () => createServerStreamStub("delta:ticker"),
  createLiquidationStream: () => createServerStreamStub("delta:liquidations"),
};
