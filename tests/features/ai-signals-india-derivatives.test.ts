import { describe, expect, it } from "vitest";

import type { DerivOiBuildup, DerivPcr } from "@/services/india/angelone/derivatives";
import type { Candle, OptionChain, OptionChainAnalytics } from "@/types/india";
import { __internals } from "@/features/ai-signals/india-builder";

const {
  indiaFactors,
  buildIndiaSignal,
  computeFuturesScreen,
  pcrMapFromRows,
  oiScoreMapFromRows,
} = __internals;

const DAY = 86_400;

/**
 * A daily series trending in `dir` (+1 up / -1 down) for `n` sessions, one
 * calendar day apart, liquid enough to clear the screen. The last candle is
 * widened into a range-expansion bar and pushed in `dir` so the full screen
 * can pass.
 */
function trendSeries(n: number, dir: 1 | -1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + dir * i * 0.5;
    out.push({
      time: i * DAY,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + dir * 0.25,
      volume: 50_000,
    });
  }
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  // Range-expansion bar in the trend direction, closing past the prior close.
  last.open = prev.close;
  last.close = prev.close + dir * 12;
  last.high = Math.max(last.open, last.close) + 2;
  last.low = Math.min(last.open, last.close) - 2;
  return out;
}

/** A flat daily series of `n` candles around `base`, optionally breaking out. */
function series(
  n: number,
  base: number,
  opts: { lastClose?: number; lastVolume?: number; volume?: number } = {},
): Candle[] {
  const vol = opts.volume ?? 1000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: i,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: vol,
    });
  }
  const last = out[out.length - 1];
  if (opts.lastClose != null) {
    last.close = opts.lastClose;
    last.high = Math.max(last.high, opts.lastClose);
    last.low = Math.min(last.low, opts.lastClose);
  }
  if (opts.lastVolume != null) last.volume = opts.lastVolume;
  return out;
}

function factor(symbolFactors: ReturnType<typeof indiaFactors>, id: string) {
  const f = symbolFactors.find((x) => x.id === id);
  if (!f) throw new Error(`factor ${id} not found`);
  return f;
}

const baseArgs = {
  symbol: "NIFTY",
  displayName: "NIFTY",
  isIndex: true,
  quote: null,
  dailies: [],
  chain: null,
  scannerScore: null,
  now: Date.now(),
  inActiveWindow: true,
  windowLabel: "Morning Trend",
  nextSession: null,
};

function makeChain(
  analytics: Partial<OptionChainAnalytics>,
): OptionChain {
  return {
    symbol: "NIFTY",
    spot: 100,
    expiry: "01-Jan-2026",
    expiries: ["01-Jan-2026"],
    rows: [],
    analytics: {
      pcrOi: null,
      pcrVolume: null,
      maxCeOiStrike: null,
      maxPeOiStrike: null,
      totalCeOi: 0,
      totalPeOi: 0,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      atmIv: null,
      maxPain: null,
      ...analytics,
    },
    fetchedAt: new Date().toISOString(),
  };
}

describe("ai-signals/india-builder derivatives wiring", () => {
  describe("pcrMapFromRows()", () => {
    it("keeps the first PCR seen per underlying", () => {
      const rows: DerivPcr[] = [
        { symbol: "NIFTY", pcr: 1.24 },
        { symbol: "BANKNIFTY", pcr: 0.82 },
        { symbol: "NIFTY", pcr: 9.9 },
      ];
      const m = pcrMapFromRows(rows);
      expect(m.get("NIFTY")).toBe(1.24);
      expect(m.get("BANKNIFTY")).toBe(0.82);
      expect(m.size).toBe(2);
    });
  });

  describe("oiScoreMapFromRows()", () => {
    it("picks the dominant (largest-OI) build-up per symbol and scores it", () => {
      const rows: DerivOiBuildup[] = [
        { symbol: "NIFTY", tradingSymbol: "x", token: null, ltp: null, percentChange: null, oi: 100, kind: "SHORT_COVERING" },
        { symbol: "NIFTY", tradingSymbol: "x", token: null, ltp: null, percentChange: null, oi: 500, kind: "LONG_BUILDUP" },
        { symbol: "TCS", tradingSymbol: "x", token: null, ltp: null, percentChange: null, oi: 300, kind: "SHORT_BUILDUP" },
      ];
      const m = oiScoreMapFromRows(rows);
      expect(m.get("NIFTY")).toEqual({ score: 1, kind: "LONG_BUILDUP" });
      expect(m.get("TCS")).toEqual({ score: -1, kind: "SHORT_BUILDUP" });
    });
  });

  describe("indiaFactors() override threading", () => {
    it("uses the first-party PCR override over the chain analytics", () => {
      const factors = indiaFactors({
        ...baseArgs,
        chain: makeChain({ pcrOi: 0.9 }),
        pcrOverride: 1.4,
      });
      // (1.4 - 1) / 0.5 = 0.8
      expect(factor(factors, "pcr").score).toBeCloseTo(0.8, 5);
      expect(factor(factors, "pcr").available).toBe(true);
    });

    it("falls back to chain PCR when no override is supplied", () => {
      const factors = indiaFactors({
        ...baseArgs,
        chain: makeChain({ pcrOi: 1.2 }),
      });
      // (1.2 - 1) / 0.5 = 0.4
      expect(factor(factors, "pcr").score).toBeCloseTo(0.4, 5);
    });

    it("uses the first-party OI build-up override as a directional score", () => {
      const factors = indiaFactors({
        ...baseArgs,
        oiOverride: { score: 1, kind: "LONG_BUILDUP" },
      });
      expect(factor(factors, "oiBuildup").score).toBeCloseTo(1, 5);
      expect(factor(factors, "oiBuildup").available).toBe(true);
    });

    it("marks PCR unavailable when neither override nor chain provide it", () => {
      const factors = indiaFactors({ ...baseArgs });
      expect(factor(factors, "pcr").available).toBe(false);
      expect(factor(factors, "pcr").score).toBe(0);
    });
  });

  describe("institutional factors", () => {
    it("scores intraday demand from the day change", () => {
      const up = indiaFactors({ ...baseArgs, dayChangePct: 1.5 });
      const down = indiaFactors({ ...baseArgs, dayChangePct: -1.5 });
      expect(factor(up, "dayChange").score).toBeGreaterThan(0.5);
      expect(factor(down, "dayChange").score).toBeLessThan(-0.5);
    });

    it("leans single names with the broad market tape", () => {
      const factors = indiaFactors({ ...baseArgs, marketRegimeScore: 0.7 });
      const f = factor(factors, "marketRegime");
      expect(f.available).toBe(true);
      expect(f.score).toBeCloseTo(0.7, 5);
    });

    it("flags a volume-confirmed resistance breakout as bullish", () => {
      const dailies = series(24, 100, { lastClose: 110, lastVolume: 4000 });
      const factors = indiaFactors({ ...baseArgs, dailies });
      expect(factor(factors, "breakout").score).toBeGreaterThan(0);
    });

    it("scores news flow directionally", () => {
      const bull = indiaFactors({
        ...baseArgs,
        newsScore: { score: 3, count: 4 },
      });
      const bear = indiaFactors({
        ...baseArgs,
        newsScore: { score: -3, count: 4 },
      });
      expect(factor(bull, "news").score).toBeGreaterThan(0);
      expect(factor(bear, "news").score).toBeLessThan(0);
    });
  });

  describe("buildIndiaSignal", () => {
    it("goes LONG (not short) when the tape + intraday demand are bullish", () => {
      const sig = buildIndiaSignal({
        ...baseArgs,
        quote: {
          symbol: "NIFTY",
          price: 100,
          change: 1.2,
          changePct: 1.2,
          prevClose: 98.8,
          fetchedAt: new Date().toISOString(),
        },
        dayChangePct: 1.2,
        marketRegimeScore: 0.8,
        intraday: true,
        horizonOverride: "intraday",
      });
      expect(sig.direction).toBe("BULLISH");
      expect(sig.action).toBe("LONG");
      expect(sig.horizon).toBe("intraday");
    });

    it("never emits spot-style BUY/SELL for India F&O", () => {
      const sig = buildIndiaSignal({
        ...baseArgs,
        quote: {
          symbol: "NIFTY",
          price: 100,
          change: -1.5,
          changePct: -1.5,
          prevClose: 101.5,
          fetchedAt: new Date().toISOString(),
        },
        dayChangePct: -1.5,
        marketRegimeScore: -0.8,
      });
      expect(["LONG", "SHORT", "WAIT"]).toContain(sig.action);
    });
  });

  describe("computeFuturesScreen", () => {
    it("returns null when history is too short", () => {
      expect(computeFuturesScreen(series(5, 100))).toBeNull();
    });

    it("passes the full bullish screen on an up-trend range-expansion bar", () => {
      const screen = computeFuturesScreen(trendSeries(210, 1));
      expect(screen).not.toBeNull();
      expect(screen!.bullPass).toBe(true);
      expect(screen!.bearPass).toBe(false);
      expect(screen!.score).toBeGreaterThanOrEqual(0.9);
      expect(screen!.metBull).toBe(7);
    });

    it("passes the full bearish mirror on a down-trend range-expansion bar", () => {
      const screen = computeFuturesScreen(trendSeries(210, -1));
      expect(screen).not.toBeNull();
      expect(screen!.bearPass).toBe(true);
      expect(screen!.bullPass).toBe(false);
      expect(screen!.score).toBeLessThanOrEqual(-0.9);
    });

    it("fails the screen without range expansion", () => {
      // A flat series: no widest-range bar, no SMA stack → not a full pass.
      const screen = computeFuturesScreen(series(210, 100));
      expect(screen).not.toBeNull();
      expect(screen!.bullPass).toBe(false);
      expect(screen!.bearPass).toBe(false);
    });

    it("treats sub-10k prior-session volume as illiquid (no bull pass)", () => {
      const c = trendSeries(210, 1);
      c[c.length - 2].volume = 500; // prior session below the liquidity gate
      const screen = computeFuturesScreen(c);
      expect(screen!.bullPass).toBe(false);
    });

    it("attaches a futuresScreen factor only when supplied", () => {
      const withScreen = indiaFactors({
        ...baseArgs,
        dailies: trendSeries(210, 1),
        futuresScreen: computeFuturesScreen(trendSeries(210, 1)),
      });
      expect(withScreen.find((f) => f.id === "futuresScreen")).toBeDefined();
      const withoutScreen = indiaFactors({ ...baseArgs, dailies: series(30, 100) });
      expect(withoutScreen.find((f) => f.id === "futuresScreen")).toBeUndefined();
    });
  });
});
