import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OptionChain } from "@/types/india";

const getOptionChainMock = vi.fn();
const getAngelChainMock = vi.fn();
const getQuoteMock = vi.fn();
let angelConfigured = false;

// `cache.memo` just runs the producer in tests (no real caching).
vi.mock("@/services/india/cache", () => ({
  cache: { memo: (_k: string, _ttl: number, fn: () => unknown) => fn() },
}));
vi.mock("@/services/india/nse", () => ({
  nse: { getOptionChain: (s: string) => getOptionChainMock(s) },
}));
vi.mock("@/services/india/angelone", () => ({
  angel: { getOptionChain: (s: string) => getAngelChainMock(s) },
  isAngelConfigured: () => angelConfigured,
}));
vi.mock("@/services/india/yahoo", () => ({
  yahoo: { getQuote: (s: string) => getQuoteMock(s) },
}));
vi.mock("@/features/india/best-time/engine", () => ({
  getBestTimeStatus: () => ({ active: { slug: "ideal", label: "Morning" } }),
}));

import { getIndiaExpiryTrades } from "@/features/india/expiry-trades/builder";

function chain(
  expiry: string,
  opts: { symbol?: string; spot?: number; rows?: OptionChain["rows"] } = {},
): OptionChain {
  return {
    symbol: opts.symbol ?? "NIFTY",
    spot: opts.spot ?? 23000,
    expiry,
    expiries: [expiry],
    rows: opts.rows ?? [],
    analytics: {
      pcrOi: 1,
      pcrVolume: 1,
      maxCeOiStrike: null,
      maxPeOiStrike: null,
      totalCeOi: 0,
      totalPeOi: 0,
      totalCeOiChange: 0,
      totalPeOiChange: 0,
      atmIv: 12,
      maxPain: null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  angelConfigured = false;
  getOptionChainMock.mockReset();
  getAngelChainMock.mockReset();
  getQuoteMock.mockReset();
  getQuoteMock.mockImplementation((s: string) =>
    Promise.resolve({
      symbol: s,
      price: s === "^BSESN" ? 75000 : 23000,
      change: 50,
      changePct: 0.6,
      prevClose: 22950,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getIndiaExpiryTrades", () => {
  it("returns no trades on a non-expiry day", async () => {
    // Monday 2026-06-15 (10:30 IST); NIFTY chain expiry is the coming Tuesday.
    vi.setSystemTime(new Date("2026-06-15T05:00:00Z"));
    getOptionChainMock.mockResolvedValue(chain("16-JUN-2026"));

    const res = await getIndiaExpiryTrades();
    expect(res.isExpiryDay).toBe(false);
    expect(res.indexes).toHaveLength(0);
  });

  it("surfaces NIFTY Gamma Blast + Hero Zero on its expiry day", async () => {
    // Tuesday 2026-06-16 — chain expiry matches today.
    vi.setSystemTime(new Date("2026-06-16T05:00:00Z"));
    getOptionChainMock.mockResolvedValue(chain("16-JUN-2026"));

    const res = await getIndiaExpiryTrades();
    expect(res.isExpiryDay).toBe(true);
    const nifty = res.indexes.find((b) => b.index === "NIFTY");
    expect(nifty).toBeDefined();
    expect(nifty?.trades.map((t) => t.kind)).toEqual([
      "GAMMA_BLAST",
      "HERO_ZERO",
    ]);
    // Bullish day change → CALLs.
    expect(nifty?.trades.every((t) => t.optionType === "CE")).toBe(true);
  });

  it("surfaces SENSEX on a Thursday via the weekday rule (estimated when Angel is off)", async () => {
    // Thursday 2026-06-18; NIFTY chain not expiring → only SENSEX shows.
    vi.setSystemTime(new Date("2026-06-18T05:00:00Z"));
    getOptionChainMock.mockResolvedValue(chain("23-JUN-2026"));

    const res = await getIndiaExpiryTrades();
    expect(res.isExpiryDay).toBe(true);
    expect(res.indexes.map((b) => b.index)).toContain("SENSEX");
    const sensex = res.indexes.find((b) => b.index === "SENSEX");
    expect(sensex?.dataSource).toBe("estimated");
  });

  it("uses the live BSE chain for SENSEX premiums when Angel One is configured", async () => {
    // Thursday 2026-06-18 — SENSEX BSE weekly expiry. Angel returns a chain
    // whose nearest expiry is today, with real ATM/OTM CALL LTPs.
    vi.setSystemTime(new Date("2026-06-18T05:00:00Z"));
    getOptionChainMock.mockResolvedValue(chain("23-JUN-2026")); // NIFTY: not today
    angelConfigured = true;
    getAngelChainMock.mockResolvedValue(
      chain("18-JUN-2026", {
        symbol: "SENSEX",
        spot: 75000,
        rows: [
          // ATM (bullish day → CE) and 3-steps-OTM CE carry live LTPs.
          { strike: 75000, ce: { ltp: 180 }, pe: { ltp: 120 } },
          { strike: 75300, ce: { ltp: 42 }, pe: { ltp: 8 } },
        ] as unknown as OptionChain["rows"],
      }),
    );

    const res = await getIndiaExpiryTrades();
    const sensex = res.indexes.find((b) => b.index === "SENSEX");
    expect(sensex).toBeDefined();
    expect(sensex?.dataSource).toBe("chain");
    expect(getAngelChainMock).toHaveBeenCalledWith("SENSEX");
    // Bullish ^BSESN change → CALLs, priced from the live chain LTPs.
    const gamma = sensex?.trades.find((t) => t.kind === "GAMMA_BLAST");
    expect(gamma?.optionType).toBe("CE");
    expect(gamma?.strike).toBe(75000);
    expect(gamma?.entryPremium).toBe(180);
    const hero = sensex?.trades.find((t) => t.kind === "HERO_ZERO");
    expect(hero?.strike).toBe(75300);
    expect(hero?.entryPremium).toBe(42);
  });

  it("falls back to estimated SENSEX premiums when the Angel chain errors", async () => {
    vi.setSystemTime(new Date("2026-06-18T05:00:00Z"));
    getOptionChainMock.mockResolvedValue(chain("23-JUN-2026"));
    angelConfigured = true;
    getAngelChainMock.mockRejectedValue(new Error("SmartAPI down"));

    const res = await getIndiaExpiryTrades();
    const sensex = res.indexes.find((b) => b.index === "SENSEX");
    expect(sensex).toBeDefined();
    expect(sensex?.dataSource).toBe("estimated");
  });
});
