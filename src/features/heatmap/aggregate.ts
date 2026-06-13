import "server-only";

import {
  LIQUIDATION_WINDOW_MS,
  REDIS_KEYS,
  TRACKED_SYMBOLS,
} from "@/lib/constants";
import { cached, redis } from "@/lib/redis";
import { getServerBroker } from "@/services/brokers/registry";
import type { NormalizedFuturesTicker } from "@/services/brokers/types";
import type { BufferedLiquidationEvent } from "@/features/futures/liquidations";
import type { SymbolId } from "@/types/market";

type FuturesTicker = NormalizedFuturesTicker & { symbol: string };

function toFuturesTicker(t: NormalizedFuturesTicker): FuturesTicker {
  // Heatmap code was originally written against the Binance shape where the
  // pair lived in `symbol`. Mirror the field so we can reuse the existing
  // grid/sector logic untouched.
  return { ...t, symbol: t.pair };
}

import {
  SECTOR_ORDER,
  type Sector,
  prettySymbol,
  sectorFor,
} from "./sectors";

const CACHE_KEY = "heatmap:overview:v1";
const CACHE_TTL_SECONDS = 30;

/** Maximum coins to render in the grid (top by quoteVolume) per page hit. */
const COIN_GRID_LIMIT = 80;

/** Minimum 24h quote volume (USD) for a pair to qualify for the grid. */
const MIN_QUOTE_VOLUME_USD = 5_000_000;

/**
 * One coin tile in the performance grid. The `weight` field is normalized
 * across the visible set so the UI can decide the tile area without re-doing
 * the math client-side. Sized roughly proportional to log(quoteVolume).
 */
export interface CoinTile {
  symbol: string;
  display: string;
  price: number;
  changePct: number;
  quoteVolume: number;
  sector: Sector;
  /** 0..1 normalized importance for tile sizing. */
  weight: number;
}

export interface SectorRow {
  sector: Sector;
  label: string;
  count: number;
  /** Volume-weighted mean of changePct across the sector's members. */
  changePct: number;
  /** Sum of quoteVolume across members (USD). */
  quoteVolume: number;
  /** Worst and best member changePct in the sector. */
  best: number;
  worst: number;
}

/** A single price-level bucket in the liquidation heatmap. */
export interface LiquidationLevel {
  /** Center price of the bucket. */
  price: number;
  /** Notional liquidated where the order side was BUY (short positions liquidated). */
  shortNotionalUsd: number;
  /** Notional liquidated where the order side was SELL (long positions liquidated). */
  longNotionalUsd: number;
  totalNotionalUsd: number;
  count: number;
}

export interface LiquidationHeatSeries {
  symbol: SymbolId;
  pair: string;
  /** Mark price the worker last saw — i.e. center of the histogram. */
  referencePrice: number;
  /** Width of each bucket as a fraction of `referencePrice`. */
  bucketPctWidth: number;
  /** Time window covered by the buffer (ms). */
  windowMs: number;
  /** Max total notional across all buckets (handy for client-side scaling). */
  maxBucketUsd: number;
  buckets: LiquidationLevel[];
  /** Total notional in the window. */
  totalNotionalUsd: number;
  /** Count of raw events in the window. */
  eventCount: number;
  /** True when no events were found in the rolling buffer. */
  empty: boolean;
}

export interface HeatmapOverview {
  generatedAt: number;
  /** Tiles for the coin performance grid, sorted by quoteVolume desc. */
  coins: CoinTile[];
  /** Sector aggregates ordered per `SECTOR_ORDER`. */
  sectors: SectorRow[];
  /** Per-symbol liquidation heat (BTC / ETH / SOL). */
  liquidations: LiquidationHeatSeries[];
}

function buildCoinTiles(tickers: FuturesTicker[]): CoinTile[] {
  const eligible = tickers
    // Binance perps quote in USDT; Delta India perps quote in USD. Accept
    // both so the heatmap grid populates regardless of the active broker.
    .filter(
      (t) =>
        (t.symbol.endsWith("USDT") || t.symbol.endsWith("USD")) &&
        t.quoteVolume >= MIN_QUOTE_VOLUME_USD,
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, COIN_GRID_LIMIT);

  if (eligible.length === 0) return [];

  // Tile area scales with log(volume) for a TradingView-style heatmap feel.
  const logVols = eligible.map((t) => Math.log10(Math.max(1, t.quoteVolume)));
  const minLog = Math.min(...logVols);
  const maxLog = Math.max(...logVols);
  const span = Math.max(0.0001, maxLog - minLog);

  return eligible.map((t, i) => {
    const norm = (logVols[i] - minLog) / span;
    return {
      symbol: t.symbol,
      display: prettySymbol(t.symbol),
      price: t.price,
      changePct: t.changePct,
      quoteVolume: t.quoteVolume,
      sector: sectorFor(t.symbol),
      // Keep weights in a sensible range — pure log normalization makes the
      // smallest tile invisible. Pin the floor at 0.35 of the largest.
      weight: 0.35 + 0.65 * norm,
    };
  });
}

function buildSectorRows(tiles: CoinTile[]): SectorRow[] {
  const buckets = new Map<Sector, CoinTile[]>();
  for (const t of tiles) {
    if (t.sector === "Other") continue;
    const list = buckets.get(t.sector) ?? [];
    list.push(t);
    buckets.set(t.sector, list);
  }

  const rows: SectorRow[] = [];
  for (const sector of SECTOR_ORDER) {
    const members = buckets.get(sector) ?? [];
    if (members.length === 0) continue;

    const totalVol = members.reduce((sum, m) => sum + m.quoteVolume, 0);
    const weightedChange =
      totalVol > 0
        ? members.reduce((sum, m) => sum + m.changePct * m.quoteVolume, 0) / totalVol
        : 0;
    const best = members.reduce((acc, m) => Math.max(acc, m.changePct), members[0].changePct);
    const worst = members.reduce((acc, m) => Math.min(acc, m.changePct), members[0].changePct);

    rows.push({
      sector,
      label: sector,
      count: members.length,
      changePct: weightedChange,
      quoteVolume: totalVol,
      best,
      worst,
    });
  }
  return rows;
}

/* ───────────── Liquidation heat (rolling buffer) ───────────── */

const LIQ_BUCKET_COUNT = 21; // odd → exactly one bucket centered on the mark
const LIQ_BUCKET_PCT_WIDTH = 0.005; // ±0.5% per bucket → ±5.25% total span

function parseBuffer(raw: string[]): BufferedLiquidationEvent[] {
  const out: BufferedLiquidationEvent[] = [];
  for (const r of raw) {
    try {
      out.push(JSON.parse(r) as BufferedLiquidationEvent);
    } catch {
      // skip malformed entries — the worker validates on write but stale data
      // could pre-date a schema change. Don't let one bad row break the page.
    }
  }
  return out;
}

function emptySeries(symbol: SymbolId, pair: string, referencePrice: number): LiquidationHeatSeries {
  return {
    symbol,
    pair,
    referencePrice,
    bucketPctWidth: LIQ_BUCKET_PCT_WIDTH,
    windowMs: LIQUIDATION_WINDOW_MS,
    maxBucketUsd: 0,
    buckets: [],
    totalNotionalUsd: 0,
    eventCount: 0,
    empty: true,
  };
}

function bucketize(
  events: BufferedLiquidationEvent[],
  referencePrice: number,
): LiquidationLevel[] {
  if (events.length === 0 || referencePrice <= 0) return [];

  const halfWidth = (LIQ_BUCKET_COUNT - 1) / 2;
  const buckets: LiquidationLevel[] = Array.from({ length: LIQ_BUCKET_COUNT }, (_, i) => {
    const offset = (i - halfWidth) * LIQ_BUCKET_PCT_WIDTH;
    return {
      price: referencePrice * (1 + offset),
      shortNotionalUsd: 0,
      longNotionalUsd: 0,
      totalNotionalUsd: 0,
      count: 0,
    };
  });

  for (const e of events) {
    if (e.price <= 0) continue;
    const offset = (e.price - referencePrice) / referencePrice;
    const bucketF = halfWidth + offset / LIQ_BUCKET_PCT_WIDTH;
    // Clamp into the visible window — far outliers stack onto the outermost
    // bucket rather than disappear, so the user still sees them as edge mass.
    const idx = Math.min(LIQ_BUCKET_COUNT - 1, Math.max(0, Math.round(bucketF)));
    const bucket = buckets[idx];
    bucket.count += 1;
    bucket.totalNotionalUsd += e.notionalUsd;
    if (e.side === "BUY") bucket.shortNotionalUsd += e.notionalUsd;
    else bucket.longNotionalUsd += e.notionalUsd;
  }

  return buckets;
}

async function buildLiquidationSeries(
  symbol: SymbolId,
  pair: string,
  tickersByPair: Map<string, FuturesTicker>,
  liquidationsSupported: boolean,
): Promise<LiquidationHeatSeries> {
  const reference = tickersByPair.get(pair)?.price ?? 0;
  if (reference <= 0) return emptySeries(symbol, pair, reference);
  // Brokers without a public liquidation feed (e.g. Delta India) skip the
  // rolling-buffer read entirely — the worker never writes to that key
  // either, but it still saves us a Redis round-trip per page render.
  if (!liquidationsSupported) return emptySeries(symbol, pair, reference);

  const key = REDIS_KEYS.liquidationBuffer(pair);
  const minScore = Date.now() - LIQUIDATION_WINDOW_MS;
  let raw: string[];
  try {
    raw = await redis.zrangeByScore(key, minScore, "+inf");
  } catch (err) {
    console.warn(`[heatmap] zrangebyscore failed for ${pair}:`, (err as Error).message);
    return emptySeries(symbol, pair, reference);
  }
  const events = parseBuffer(raw);
  if (events.length === 0) return emptySeries(symbol, pair, reference);

  const buckets = bucketize(events, reference);
  let maxBucketUsd = 0;
  let totalNotionalUsd = 0;
  for (const b of buckets) {
    totalNotionalUsd += b.totalNotionalUsd;
    if (b.totalNotionalUsd > maxBucketUsd) maxBucketUsd = b.totalNotionalUsd;
  }

  return {
    symbol,
    pair,
    referencePrice: reference,
    bucketPctWidth: LIQ_BUCKET_PCT_WIDTH,
    windowMs: LIQUIDATION_WINDOW_MS,
    maxBucketUsd,
    buckets,
    totalNotionalUsd,
    eventCount: events.length,
    empty: false,
  };
}

export async function getHeatmapOverview(): Promise<HeatmapOverview> {
  return cached(CACHE_KEY, CACHE_TTL_SECONDS, async () => {
    const broker = getServerBroker();
    const tickers = await broker
      .fetchAllFuturesTickers()
      .then((list) => list.map(toFuturesTicker))
      .catch((err: unknown) => {
        console.warn("[heatmap] tickers fetch failed:", (err as Error).message);
        return [] as FuturesTicker[];
      });
    const tiles = buildCoinTiles(tickers);
    const sectors = buildSectorRows(tiles);

    const byPair = new Map<string, FuturesTicker>();
    for (const t of tickers) byPair.set(t.symbol, t);

    const liquidationsSupported = broker.capabilities.liquidations;
    const liquidations = await Promise.all(
      TRACKED_SYMBOLS.map((s) =>
        buildLiquidationSeries(s.id, broker.pairs.futures[s.id], byPair, liquidationsSupported),
      ),
    );

    return {
      generatedAt: Date.now(),
      coins: tiles,
      sectors,
      liquidations,
    };
  });
}
