/**
 * Daily Picks — Market Context Header builder.
 *
 * The header is the "Market Context Block" from the institutional spec: a
 * single deterministic summary published once per refresh that anchors every
 * pick on the day's NIFTY / BANKNIFTY / VIX / PCR / Max Pain / regime read.
 * Pure: same inputs → same output, no I/O.
 */
import { describe, expect, it } from "vitest";

import type { AiMarketContext } from "@/types/ai-signals";
import type { OptionChain, OptionChainAnalytics, OptionChainRow } from "@/types/india";
import {
  buildMarketContextHeader,
  classifyIndiaVixRegime,
  classifyPcr,
  classifyTrend,
} from "@/features/india/daily-picks/market-context";

function analytics(over: Partial<OptionChainAnalytics> = {}): OptionChainAnalytics {
  return {
    pcrOi: 1.2,
    pcrVolume: 1.1,
    maxCeOiStrike: 25_000,
    maxPeOiStrike: 24_000,
    totalCeOi: 1_000_000,
    totalPeOi: 1_200_000,
    totalCeOiChange: 50_000,
    totalPeOiChange: 80_000,
    atmIv: 14,
    maxPain: 24_500,
    ...over,
  };
}

function chain(over: Partial<OptionChain> = {}): OptionChain {
  return {
    symbol: "NIFTY",
    spot: 24_600,
    expiry: "2026-06-25",
    expiries: ["2026-06-25"],
    rows: [],
    analytics: analytics(),
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

function context(over: Partial<AiMarketContext> = {}): AiMarketContext {
  return {
    market: "india",
    regime: "risk-on",
    regimeScore: 0.45,
    headline: "Risk-on — indices firm, VIX contained.",
    bullets: ["NIFTY +0.6%", "India VIX 13.4"],
    inActiveWindow: true,
    windowLabel: "Morning Trend",
    dataFreshness: "live",
    ...over,
  };
}

describe("classifyTrend", () => {
  it("calls > 0.4% changePct bullish, < -0.4% bearish, otherwise sideways", () => {
    expect(classifyTrend(0.8)).toBe("bullish");
    expect(classifyTrend(-0.9)).toBe("bearish");
    expect(classifyTrend(0.1)).toBe("sideways");
    expect(classifyTrend(-0.1)).toBe("sideways");
    expect(classifyTrend(null)).toBe("sideways");
  });
});

describe("classifyIndiaVixRegime", () => {
  it("low <13 / moderate 13-18 / high 18-25 / extreme >25", () => {
    expect(classifyIndiaVixRegime(11.5)).toBe("low");
    expect(classifyIndiaVixRegime(14)).toBe("moderate");
    expect(classifyIndiaVixRegime(20.5)).toBe("high");
    expect(classifyIndiaVixRegime(28)).toBe("extreme");
  });

  it("nulls / NaN are treated as moderate (safe default)", () => {
    expect(classifyIndiaVixRegime(null)).toBe("moderate");
    expect(classifyIndiaVixRegime(Number.NaN)).toBe("moderate");
  });
});

describe("classifyPcr", () => {
  it(">1.3 bullish, <0.7 bearish, otherwise neutral", () => {
    expect(classifyPcr(1.45)).toBe("bullish");
    expect(classifyPcr(0.55)).toBe("bearish");
    expect(classifyPcr(1.0)).toBe("neutral");
    expect(classifyPcr(null)).toBe("neutral");
  });
});

describe("buildMarketContextHeader", () => {
  it("assembles a complete header with NIFTY / BANKNIFTY / VIX / PCR / Max Pain / bias", () => {
    const header = buildMarketContextHeader({
      now: new Date("2026-06-17T10:30:00Z").getTime(), // 16:00 IST
      indices: {
        NIFTY: { level: 24_600, changePct: 0.6 },
        BANKNIFTY: { level: 52_400, changePct: 0.25 },
      },
      chains: {
        NIFTY: chain(),
        BANKNIFTY: chain({
          symbol: "BANKNIFTY",
          spot: 52_400,
          analytics: analytics({ maxPain: 52_000, pcrOi: 1.18 }),
        }),
      },
      indiaVix: 13.5,
      context: context(),
    });

    expect(header.nifty?.level).toBe(24_600);
    expect(header.nifty?.trend).toBe("bullish");
    // From chain: max CE OI strike = resistance, max PE OI strike = support
    expect(header.nifty?.support).toBe(24_000);
    expect(header.nifty?.resistance).toBe(25_000);

    expect(header.banknifty?.level).toBe(52_400);
    expect(header.banknifty?.trend).toBe("sideways"); // 0.25% < 0.4%

    expect(header.indiaVix?.value).toBe(13.5);
    expect(header.indiaVix?.regime).toBe("moderate");

    expect(header.pcrNifty?.value).toBe(1.2);
    expect(header.pcrNifty?.interpretation).toBe("neutral");

    expect(header.maxPain.nifty).toBe(24_500);
    expect(header.maxPain.banknifty).toBe(52_000);

    expect(header.bias.regime).toBe("risk-on");
    expect(header.bias.headline.length).toBeGreaterThan(0);

    // Date label is rendered in IST.
    expect(header.date).toMatch(/2026/);
  });

  it("gracefully handles missing chains / VIX / quotes", () => {
    const header = buildMarketContextHeader({
      now: Date.now(),
      indices: {},
      chains: {},
      indiaVix: null,
      context: context(),
    });
    expect(header.nifty).toBeNull();
    expect(header.banknifty).toBeNull();
    expect(header.indiaVix).toBeNull();
    expect(header.pcrNifty).toBeNull();
    expect(header.maxPain.nifty).toBeNull();
    expect(header.maxPain.banknifty).toBeNull();
    // FII flow + sector watch are honest nulls when the data source is absent
    expect(header.fiiFlow).toBeNull();
    expect(header.sectorWatch).toBeNull();
    // Bias still reflects the regime — its inputs are independent of the
    // single-index breakdown.
    expect(header.bias.regime).toBe("risk-on");
  });

  it("calls a strong-PCR chain bullish and a low-PCR chain bearish", () => {
    const bullish = buildMarketContextHeader({
      now: Date.now(),
      indices: { NIFTY: { level: 24_000, changePct: 0 } },
      chains: { NIFTY: chain({ analytics: analytics({ pcrOi: 1.6 }) }) },
      indiaVix: 14,
      context: context(),
    });
    expect(bullish.pcrNifty?.interpretation).toBe("bullish");

    const bearish = buildMarketContextHeader({
      now: Date.now(),
      indices: { NIFTY: { level: 24_000, changePct: 0 } },
      chains: { NIFTY: chain({ analytics: analytics({ pcrOi: 0.55 }) }) },
      indiaVix: 14,
      context: context(),
    });
    expect(bearish.pcrNifty?.interpretation).toBe("bearish");
  });

  it("flags HIGH VIX in the bias headline when VIX > 20", () => {
    const header = buildMarketContextHeader({
      now: Date.now(),
      indices: { NIFTY: { level: 24_000, changePct: -0.6 } },
      chains: { NIFTY: chain() },
      indiaVix: 22.4,
      context: context({ regime: "risk-off", regimeScore: -0.5 }),
    });
    expect(header.indiaVix?.regime).toBe("high");
    expect(header.bias.headline.toLowerCase()).toMatch(/vix|risk/);
  });

  it("accepts optional fiiFlow + sectorWatch passthroughs", () => {
    // Even though we don't compute these today, the API surface should accept
    // them so a future data source can plug straight in without a refactor.
    const header = buildMarketContextHeader({
      now: Date.now(),
      indices: { NIFTY: { level: 24_000, changePct: 0.3 } },
      chains: { NIFTY: chain() },
      indiaVix: 13,
      context: context(),
      fiiFlow: { netCr: -1240, note: "FII net sellers in F&O" },
      sectorWatch: {
        strong: ["IT", "Auto"],
        weak: ["Realty", "Metal"],
      },
    });
    expect(header.fiiFlow?.netCr).toBe(-1240);
    expect(header.sectorWatch?.strong).toEqual(["IT", "Auto"]);
    expect(header.sectorWatch?.weak).toEqual(["Realty", "Metal"]);
  });
});

/** Silence unused-import nagging if this file is imported by another suite. */
// `OptionChainRow` is referenced in the chain factory above (rows: []) so it
// type-checks; keep the import for readers.
export type { OptionChainRow };
