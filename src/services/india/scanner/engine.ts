// Scanner Engine — computes ranked lists of F&O hits across multiple
// strategy types. Each scanner returns `ScannerResult` so the UI can render
// every type with the same component.

import type { Candle, Quote } from "@/types/india";
import type {
  OiBuildupKind,
  ScannerHit,
  ScannerResult,
  ScannerType,
} from "@/types/india/scanner";
import { FNO_INDICES, FNO_STOCKS } from "@/lib/india/fno-symbols";
import { yahoo } from "@/services/india/yahoo";
import { nse } from "@/services/india/nse";
import { angel, isAngelConfigured } from "@/services/india/angelone";
import { cache } from "@/services/india/cache";

const now = () => new Date().toISOString();

async function fnoQuotes(): Promise<Quote[]> {
  return cache.memo("scanner:fno-quotes", 10_000, () =>
    yahoo.getQuotes(FNO_STOCKS),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Momentum: top gainers/losers among the F&O universe
// ────────────────────────────────────────────────────────────────────────────

/**
 * Angel One first-party F&O momentum — true price gainers/losers from the
 * derivatives segment (NEAR expiry), not a % move derived off Yahoo cash
 * quotes. Returns null when SmartAPI is unconfigured / empty so the caller
 * falls back to the Yahoo path.
 */
async function runMomentumAngel(limit: number): Promise<ScannerResult | null> {
  if (!isAngelConfigured()) return null;
  const [gainers, losers] = await Promise.all([
    angel.getTopGainersLosers("PercPriceGainers", "NEAR"),
    angel.getTopGainersLosers("PercPriceLosers", "NEAR"),
  ]);
  const merged = [...gainers, ...losers];
  if (merged.length === 0) return null;

  const hits: ScannerHit[] = merged
    .filter((r) => r.percentChange != null)
    .sort(
      (a, b) => Math.abs(b.percentChange ?? 0) - Math.abs(a.percentChange ?? 0),
    )
    .slice(0, limit)
    .map((r) => ({
      symbol: r.symbol,
      price: r.ltp,
      changePct: r.percentChange,
      volume: null,
      metric: r.percentChange ?? 0,
      metricLabel: `${(r.percentChange ?? 0) >= 0 ? "+" : ""}${(r.percentChange ?? 0).toFixed(2)}%`,
      kind: (r.percentChange ?? 0) >= 0 ? "GAINER" : "LOSER",
      note: r.oi != null ? `OI ${(r.oi / 1e5).toFixed(1)}L` : undefined,
    }));

  return {
    type: "momentum",
    title: "Momentum Scanner",
    description:
      "Top F&O price gainers / losers (near-month futures) — Angel One SmartAPI.",
    hits,
    fetchedAt: now(),
  };
}

async function runMomentum(limit: number): Promise<ScannerResult> {
  const fromAngel = await runMomentumAngel(limit);
  if (fromAngel) return fromAngel;

  const quotes = await fnoQuotes();
  const sorted = quotes
    .filter((q) => q.changePct != null)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
    .slice(0, limit);

  const hits: ScannerHit[] = sorted.map((q) => ({
    symbol: q.symbol,
    price: q.price,
    changePct: q.changePct,
    volume: q.volume ?? null,
    metric: q.changePct ?? 0,
    metricLabel: `${(q.changePct ?? 0) >= 0 ? "+" : ""}${(q.changePct ?? 0).toFixed(2)}%`,
    kind: (q.changePct ?? 0) >= 0 ? "GAINER" : "LOSER",
  }));

  return {
    type: "momentum",
    title: "Momentum Scanner",
    description: "Highest absolute % moves across NSE F&O stocks (intraday).",
    hits,
    fetchedAt: now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Volume breakout: today's volume vs 20-day average
// ────────────────────────────────────────────────────────────────────────────

async function avgVolume(symbol: string): Promise<number | null> {
  const cacheKey = `scanner:avgvol:${symbol}`;
  return cache.memo(cacheKey, 5 * 60_000, async () => {
    try {
      const candles = await yahoo.getHistorical({
        symbol,
        interval: "1d",
        range: "30d",
      });
      const vols = candles
        .map((c) => c.volume ?? 0)
        .filter((v) => v > 0)
        .slice(-20);
      if (vols.length === 0) return null;
      return vols.reduce((a, b) => a + b, 0) / vols.length;
    } catch {
      return null;
    }
  });
}

async function runVolumeBreakout(limit: number): Promise<ScannerResult> {
  const quotes = await fnoQuotes();
  const candidates = quotes
    .filter((q) => q.volume != null && q.changePct != null)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
    .slice(0, 50);

  const ratios = await Promise.all(
    candidates.map(async (q) => {
      const avg = await avgVolume(q.symbol);
      const ratio = avg && avg > 0 && q.volume ? q.volume / avg : null;
      return { q, avg, ratio };
    }),
  );

  const sorted = ratios
    .filter((r) => r.ratio != null && r.ratio > 1.5)
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
    .slice(0, limit);

  const hits: ScannerHit[] = sorted.map(({ q, ratio }) => ({
    symbol: q.symbol,
    price: q.price,
    changePct: q.changePct,
    volume: q.volume ?? null,
    metric: ratio ?? 0,
    metricLabel: `${(ratio ?? 0).toFixed(2)}× avg`,
    kind: (q.changePct ?? 0) >= 0 ? "BULL_VOLUME" : "BEAR_VOLUME",
    note:
      (q.changePct ?? 0) >= 0
        ? "Volume breakout with positive price action"
        : "Heavy distribution / capitulation volume",
  }));

  return {
    type: "volume-breakout",
    title: "Volume Breakout",
    description:
      "F&O stocks with today's volume ≥ 1.5× their 20-day average volume.",
    hits,
    fetchedAt: now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Option-chain backed scanners (PCR, IV, OI buildup)
// ────────────────────────────────────────────────────────────────────────────

const INDEX_UNDERLYINGS = FNO_INDICES.map((i) => i.underlying);

async function indexChains() {
  return cache.memo("scanner:index-chains", 20_000, async () => {
    const out = await Promise.allSettled(
      INDEX_UNDERLYINGS.map((u) => nse.getOptionChain(u)),
    );
    return out
      .map((r, i) =>
        r.status === "fulfilled"
          ? { underlying: INDEX_UNDERLYINGS[i], chain: r.value }
          : null,
      )
      .filter(Boolean) as {
      underlying: string;
      chain: Awaited<ReturnType<typeof nse.getOptionChain>>;
    }[];
  });
}

/**
 * Angel One first-party PCR across the whole F&O segment (not just the four
 * indices the NSE chain covers). Returns null when unconfigured / empty.
 */
async function runPcrAngel(limit: number): Promise<ScannerResult | null> {
  if (!isAngelConfigured()) return null;
  const rows = await angel.getPutCallRatio();
  if (rows.length === 0) return null;

  const hits: ScannerHit[] = rows
    .sort((a, b) => Math.abs(b.pcr - 1) - Math.abs(a.pcr - 1))
    .slice(0, limit)
    .map((r) => ({
      symbol: r.symbol,
      price: null,
      changePct: null,
      metric: r.pcr,
      metricLabel: `PCR ${r.pcr.toFixed(2)}`,
      kind: r.pcr > 1.3 ? "BULLISH" : r.pcr < 0.7 ? "BEARISH" : "NEUTRAL",
    }));

  return {
    type: "pcr",
    title: "PCR Scanner",
    description:
      "First-party Put-Call Ratio across the F&O segment (Angel One SmartAPI). >1.3 typically bullish, <0.7 bearish.",
    hits,
    fetchedAt: now(),
  };
}

async function runPcr(limit: number): Promise<ScannerResult> {
  const fromAngel = await runPcrAngel(limit);
  if (fromAngel) return fromAngel;

  const chains = await indexChains();
  const hits: ScannerHit[] = chains
    .map(({ underlying, chain }) => {
      const pcr = chain.analytics.pcrOi ?? 0;
      let kind: string = "NEUTRAL";
      if (pcr > 1.3) kind = "BULLISH";
      else if (pcr < 0.7) kind = "BEARISH";
      return {
        symbol: underlying,
        price: chain.spot,
        changePct: null,
        metric: pcr,
        metricLabel: `PCR ${pcr.toFixed(2)}`,
        kind,
        note: `Max PE OI @ ${chain.analytics.maxPeOiStrike ?? "—"} · Max CE OI @ ${chain.analytics.maxCeOiStrike ?? "—"}`,
      };
    })
    .sort((a, b) => b.metric - a.metric);

  return {
    type: "pcr",
    title: "PCR Scanner",
    description:
      "Put-Call Ratio (by OI) across F&O indices. >1.3 typically bullish, <0.7 bearish.",
    hits,
    fetchedAt: now(),
  };
}

async function runIvSpike(): Promise<ScannerResult> {
  const chains = await indexChains();
  const hits: ScannerHit[] = chains
    .map(({ underlying, chain }) => ({
      symbol: underlying,
      price: chain.spot,
      changePct: null,
      metric: chain.analytics.atmIv ?? 0,
      metricLabel: `ATM IV ${(chain.analytics.atmIv ?? 0).toFixed(1)}%`,
      kind:
        (chain.analytics.atmIv ?? 0) > 20
          ? "ELEVATED"
          : (chain.analytics.atmIv ?? 0) > 14
            ? "NORMAL"
            : "LOW",
      note: `Max-pain ${chain.analytics.maxPain ?? "—"}`,
    }))
    .sort((a, b) => b.metric - a.metric);

  return {
    type: "iv-spike",
    title: "IV Scanner",
    description:
      "Average ATM implied volatility (CE+PE within ±5 strikes) on F&O indices.",
    hits,
    fetchedAt: now(),
  };
}

/**
 * Angel One first-party OI build-up — authoritative Long/Short Built Up ·
 * Short Covering · Long Unwinding lists across the whole F&O segment. This
 * replaces the chain-derived classification that depended on per-strike ΔOI
 * (which the synthesised Angel chain reports as 0). Returns null when
 * unconfigured / empty so the NSE-derived path still works.
 */
async function runOiBuildupAngel(limit: number): Promise<ScannerResult | null> {
  if (!isAngelConfigured()) return null;
  const [longBuilt, shortBuilt, shortCover, longUnwind] = await Promise.all([
    angel.getOiBuildup("Long Built Up", "NEAR"),
    angel.getOiBuildup("Short Built Up", "NEAR"),
    angel.getOiBuildup("Short Covering", "NEAR"),
    angel.getOiBuildup("Long Unwinding", "NEAR"),
  ]);
  const merged = [...longBuilt, ...shortBuilt, ...shortCover, ...longUnwind];
  if (merged.length === 0) return null;

  const hits: ScannerHit[] = merged
    .sort((a, b) => (b.oi ?? 0) - (a.oi ?? 0))
    .slice(0, limit)
    .map((r) => ({
      symbol: r.symbol,
      price: r.ltp,
      changePct: r.percentChange,
      metric: r.oi ?? 0,
      metricLabel: r.kind.replace("_", " "),
      kind: r.kind,
      note: r.oi != null ? `OI ${(r.oi / 1e5).toFixed(1)}L` : undefined,
    }));

  return {
    type: "oi-buildup",
    title: "OI Buildup",
    description:
      "First-party F&O open-interest build-up (Long/Short Built Up · Short Covering · Long Unwinding) — Angel One SmartAPI.",
    hits,
    fetchedAt: now(),
  };
}

async function runOiBuildup(limit: number): Promise<ScannerResult> {
  const fromAngel = await runOiBuildupAngel(limit);
  if (fromAngel) return fromAngel;

  const chains = await indexChains();
  const yfQuotes = await yahoo.getQuotes(FNO_INDICES.map((i) => i.symbol));
  const priceChange: Record<string, number | null> = {};
  FNO_INDICES.forEach((i, idx) => {
    priceChange[i.underlying] = yfQuotes[idx]?.changePct ?? null;
  });

  const hits: ScannerHit[] = chains
    .map(({ underlying, chain }) => {
      const a = chain.analytics;
      const oiNet = (a.totalCeOiChange ?? 0) + (a.totalPeOiChange ?? 0);
      const peMinusCeOi = (a.totalPeOiChange ?? 0) - (a.totalCeOiChange ?? 0);
      const pct = priceChange[underlying] ?? 0;
      const oiUp = oiNet > 0;

      let kind: OiBuildupKind = "LONG_UNWINDING";
      if (pct >= 0 && oiUp) kind = "LONG_BUILDUP";
      else if (pct < 0 && oiUp) kind = "SHORT_BUILDUP";
      else if (pct >= 0 && !oiUp) kind = "SHORT_COVERING";
      else kind = "LONG_UNWINDING";

      return {
        symbol: underlying,
        price: chain.spot,
        changePct: pct,
        metric: peMinusCeOi,
        metricLabel: kind.replace("_", " "),
        kind,
        note: `ΔPE OI ${(a.totalPeOiChange / 1e5).toFixed(1)}L · ΔCE OI ${(a.totalCeOiChange / 1e5).toFixed(1)}L`,
      } satisfies ScannerHit;
    })
    .sort((a, b) => Math.abs(b.metric) - Math.abs(a.metric));

  return {
    type: "oi-buildup",
    title: "OI Buildup",
    description:
      "Open-interest direction × price action across F&O indices (long/short build-up & unwinding).",
    hits,
    fetchedAt: now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Range Expansion (Chartink "WR8 + Bullish Trend Stack" equivalent)
// ────────────────────────────────────────────────────────────────────────────

type RangeExpansionParams = {
  rangeMultiple: number;
  volMultiple: number;
  closeStrength: number;
  minPrevVolume: number;
};

const DEFAULT_RX: RangeExpansionParams = {
  rangeMultiple: 1.2,
  volMultiple: 1.5,
  closeStrength: 0.5,
  minPrevVolume: 50_000,
};

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return avg(closes.slice(-period));
}

async function pmap<T, R>(
  items: T[],
  worker: (t: T) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await worker(items[idx]);
      }
    },
  );
  await Promise.all(runners);
  return out;
}

function currentWeekCandles(dailies: Candle[]): Candle[] {
  if (dailies.length === 0) return [];
  const lastDate = new Date(dailies[dailies.length - 1].time * 1000);
  const dow = (lastDate.getUTCDay() + 6) % 7;
  const mondayMs =
    Date.UTC(
      lastDate.getUTCFullYear(),
      lastDate.getUTCMonth(),
      lastDate.getUTCDate(),
    ) -
    dow * 86_400_000;
  const mondaySec = Math.floor(mondayMs / 1000);
  return dailies.filter((c) => c.time >= mondaySec);
}

function currentMonthCandles(dailies: Candle[]): Candle[] {
  if (dailies.length === 0) return [];
  const last = new Date(dailies[dailies.length - 1].time * 1000);
  const monthStartSec = Math.floor(
    Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1) / 1000,
  );
  return dailies.filter((c) => c.time >= monthStartSec);
}

type RxRow = {
  symbol: string;
  closeNow: number;
  highNow: number;
  lowNow: number;
  openNow: number;
  prevClose: number;
  prevVolume: number;
  todayRange: number;
  prev7MaxRange: number;
  rangeRatio: number;
  volRatio: number;
  closeStrength: number;
  sma20: number;
  sma50: number;
  sma200: number;
  changePct: number;
  volume: number;
};

async function evaluateRangeExpansion(
  symbol: string,
  params: RangeExpansionParams,
): Promise<RxRow | null> {
  let dailies: Candle[];
  try {
    dailies = await yahoo.getHistorical({
      symbol,
      interval: "1d",
      range: "1y",
    });
  } catch {
    return null;
  }
  if (dailies.length < 200) return null;

  const last = dailies[dailies.length - 1];
  const prev = dailies[dailies.length - 2];
  if (!last || !prev) return null;

  const closeNow = last.close;
  const openNow = last.open;
  const highNow = last.high;
  const lowNow = last.low;
  const prevClose = prev.close;
  const prevVolume = prev.volume ?? 0;

  const prev7 = dailies.slice(-8, -1);
  if (prev7.length < 7) return null;
  const prev7MaxRange = Math.max(...prev7.map((c) => c.high - c.low));
  const todayRange = highNow - lowNow;
  if (todayRange <= 0 || prev7MaxRange <= 0) return null;
  if (todayRange < prev7MaxRange * params.rangeMultiple) return null;

  if (!(closeNow > openNow)) return null;
  if (!(closeNow > prevClose)) return null;
  if (prevVolume < params.minPrevVolume) return null;

  const week = currentWeekCandles(dailies);
  if (week.length === 0) return null;
  const weekOpen = week[0].open;
  if (!(closeNow > weekOpen)) return null;

  const month = currentMonthCandles(dailies);
  if (month.length === 0) return null;
  const monthOpen = month[0].open;
  if (!(closeNow > monthOpen)) return null;

  const closes = dailies.map((c) => c.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  if (sma20 == null || sma50 == null || sma200 == null) return null;
  if (!(sma20 > sma50 && sma50 > sma200)) return null;

  const vols = dailies
    .slice(-21, -1)
    .map((c) => c.volume ?? 0)
    .filter((v) => v > 0);
  const avgVol20 = avg(vols);
  const todayVolume = last.volume ?? 0;
  if (avgVol20 <= 0) return null;
  const volRatio = todayVolume / avgVol20;
  if (volRatio < params.volMultiple) return null;

  const closeStrengthVal = (closeNow - lowNow) / todayRange;
  if (closeStrengthVal < params.closeStrength) return null;

  const changePct = ((closeNow - prevClose) / prevClose) * 100;

  return {
    symbol,
    closeNow,
    highNow,
    lowNow,
    openNow,
    prevClose,
    prevVolume,
    todayRange,
    prev7MaxRange,
    rangeRatio: todayRange / prev7MaxRange,
    volRatio,
    closeStrength: closeStrengthVal,
    sma20,
    sma50,
    sma200,
    changePct,
    volume: todayVolume,
  };
}

async function runRangeExpansion(
  limit: number,
  overrides: Partial<RangeExpansionParams> = {},
): Promise<ScannerResult> {
  const params: RangeExpansionParams = { ...DEFAULT_RX, ...overrides };

  const quotes = await fnoQuotes();
  const preFiltered = quotes.filter(
    (q) =>
      q.changePct != null &&
      q.changePct > 0 &&
      q.high != null &&
      q.low != null &&
      q.open != null &&
      q.price != null &&
      q.high - q.low > 0,
  );

  const rows = await cache.memo(
    `scanner:range-expansion:${params.rangeMultiple}:${params.volMultiple}:${params.closeStrength}:${params.minPrevVolume}`,
    5 * 60_000,
    async () => {
      const symbols = preFiltered.map((q) => q.symbol);
      const evaluated = await pmap(
        symbols,
        (s) => evaluateRangeExpansion(s, params).catch(() => null),
        8,
      );
      return evaluated.filter(Boolean) as RxRow[];
    },
  );

  const scored = rows
    .map((r) => ({
      r,
      score: r.rangeRatio * r.volRatio * (0.5 + r.closeStrength),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const hits: ScannerHit[] = scored.map(({ r, score }) => ({
    symbol: r.symbol,
    price: r.closeNow,
    changePct: r.changePct,
    volume: r.volume,
    metric: score,
    metricLabel: `${r.rangeRatio.toFixed(2)}× rng · ${r.volRatio.toFixed(2)}× vol`,
    kind: "RANGE_EXPANSION",
    note:
      `WR8 breakout · close ${(r.closeStrength * 100).toFixed(0)}% of range · ` +
      `SMA 20/50/200 ${r.sma20.toFixed(0)}/${r.sma50.toFixed(0)}/${r.sma200.toFixed(0)}`,
  }));

  return {
    type: "range-expansion",
    title: "Range Expansion (WR8 + Bullish Trend)",
    description:
      "Today's H−L is the widest of the past 8 sessions, with a bullish daily/weekly/monthly close, SMA 20>50>200 stack, vol ≥ 1.5× 20-day avg, and close in the upper half of the range.",
    hits,
    fetchedAt: now(),
  };
}

export async function runScanner(
  type: ScannerType,
  limit = 25,
): Promise<ScannerResult> {
  switch (type) {
    case "momentum":
      return runMomentum(limit);
    case "volume-breakout":
      return runVolumeBreakout(limit);
    case "pcr":
      return runPcr(limit);
    case "iv-spike":
      return runIvSpike();
    case "oi-buildup":
      return runOiBuildup(limit);
    case "range-expansion":
      return runRangeExpansion(limit);
  }
}
