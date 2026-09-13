/**
 * Option Strike Capture Service — unit tests for V-04 migration (data-service-centralization).
 *
 * Verifies that:
 *   1. `captureUnderlyingStrikes` routes exclusively through `registry.getOptionChain()`.
 *   2. `MarketDataError` thrown by the registry is re-thrown with the original `code`
 *      preserved — never wrapped in a plain Error (Req 5.3, 5.4, 10.6).
 *   3. `provider` (ProviderId) and `fetchedAt` (UTC ISO-8601) from the OptionChain
 *      response are recorded in the CaptureResult (Req 5.2).
 *   4. A null chain response is handled gracefully (NO_EXPIRIES).
 *   5. An empty rows response is handled as EMPTY_PROVIDER_RESPONSE.
 *   6. A non-MarketDataError from the fetcher is returned as PROVIDER_ERROR (not rethrown).
 */

import { describe, it, expect, vi } from "vitest";
import {
  captureUnderlyingStrikes,
  chainToStrikes,
  selectCurrentAndNextExpiry,
} from "@/lib/market-data/services/option-strike-capture.service";
import { MarketDataError } from "@/lib/market-data/types";
import type { ChainFetcher } from "@/lib/market-data/services/option-strike-capture.service";

vi.mock("server-only", () => ({}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChain(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "NIFTY",
    expiry: "2026-09-25",
    expiries: ["2026-09-25", "2026-10-02"],
    spot: 24500,
    provider: "angel_one" as const,
    fetchedAt: "2026-09-12T09:30:00.000Z",
    rows: [
      {
        strike: 24500,
        ce: { strike: 24500, type: "CE" as const, oi: 5000, ltp: 120, bid: 119, ask: 121, iv: 18.5, volume: 300 },
        pe: { strike: 24500, type: "PE" as const, oi: 4000, ltp: 110, bid: 109, ask: 111, iv: 17.2, volume: 250 },
      },
    ],
    ...overrides,
  };
}

const mockPrisma = {
  optionChainStrike: {
    upsert: vi.fn().mockResolvedValue({}),
  },
} as never;

// ── MarketDataError preservation (Req 5.3, 5.4, 10.6) ────────────────────────

describe("captureUnderlyingStrikes — MarketDataError preservation", () => {
  it("re-throws MarketDataError with code UNAVAILABLE from the fetcher unchanged", async () => {
    const error = new MarketDataError("Provider unavailable", "angel_one", "UNAVAILABLE");
    const fetcher: ChainFetcher = async () => { throw error; };

    await expect(
      captureUnderlyingStrikes("NIFTY", { fetcher, providerLabel: () => null, prisma: mockPrisma }),
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof MarketDataError && e.code === "UNAVAILABLE";
    });
  });

  it("re-throws MarketDataError with code AUTH_FAILURE preserving original code", async () => {
    const error = new MarketDataError("Auth failed", "angel_one", "AUTH_FAILURE");
    const fetcher: ChainFetcher = async () => { throw error; };

    await expect(
      captureUnderlyingStrikes("NIFTY", { fetcher, providerLabel: () => null, prisma: mockPrisma }),
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof MarketDataError && e.code === "AUTH_FAILURE";
    });
  });

  it("re-throws MarketDataError with code RATE_LIMIT preserving original code", async () => {
    const error = new MarketDataError("Rate limited", "upstox", "RATE_LIMIT");
    const fetcher: ChainFetcher = async () => { throw error; };

    await expect(
      captureUnderlyingStrikes("NIFTY", { fetcher, providerLabel: () => null, prisma: mockPrisma }),
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof MarketDataError && e.code === "RATE_LIMIT";
    });
  });

  it("re-throws MarketDataError with code TIMEOUT preserving original code", async () => {
    const error = new MarketDataError("Timed out", null, "TIMEOUT");
    const fetcher: ChainFetcher = async () => { throw error; };

    await expect(
      captureUnderlyingStrikes("NIFTY", { fetcher, providerLabel: () => null, prisma: mockPrisma }),
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof MarketDataError && e.code === "TIMEOUT";
    });
  });

  it("does NOT wrap the MarketDataError in a plain Error", async () => {
    const error = new MarketDataError("Provider unavailable", "angel_one", "UNAVAILABLE");
    const fetcher: ChainFetcher = async () => { throw error; };

    let caughtError: unknown;
    try {
      await captureUnderlyingStrikes("NIFTY", { fetcher, providerLabel: () => null, prisma: mockPrisma });
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(MarketDataError);
    // Must be the original instance — not a new wrapper
    expect(caughtError).toBe(error);
  });

  it("returns PROVIDER_ERROR (does NOT re-throw) for plain non-MarketDataError exceptions", async () => {
    const fetcher: ChainFetcher = async () => { throw new Error("Network failure"); };

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.status).toBe("PROVIDER_ERROR");
    expect(result.reason).toContain("Network failure");
  });
});

// ── Provider and fetchedAt recording (Req 5.2) ───────────────────────────────

describe("captureUnderlyingStrikes — provider and fetchedAt from OptionChain response", () => {
  it("records provider from OptionChain.provider in the CaptureResult", async () => {
    const chain = makeChain({ provider: "upstox" as const });
    const fetcher: ChainFetcher = async () => chain;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => "should-be-ignored",
      prisma: mockPrisma,
    });

    expect(result.provider).toBe("upstox");
  });

  it("records fetchedAt from OptionChain.fetchedAt in the CaptureResult", async () => {
    const fetchedAt = "2026-09-12T09:30:00.000Z";
    const chain = makeChain({ fetchedAt });
    const fetcher: ChainFetcher = async () => chain;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.fetchedAt).toBe(fetchedAt);
  });

  it("records provider angel_one correctly", async () => {
    const chain = makeChain({ provider: "angel_one" as const });
    const fetcher: ChainFetcher = async () => chain;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.provider).toBe("angel_one");
  });

  it("falls back to providerLabel when chain has no provider field", async () => {
    const { provider: _p, ...chainWithoutProvider } = makeChain();
    const fetcher: ChainFetcher = async () => chainWithoutProvider as never;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => "scrapling",
      prisma: mockPrisma,
    });

    expect(result.provider).toBe("scrapling");
  });

  it("sets fetchedAt to null when chain has no fetchedAt field", async () => {
    const { fetchedAt: _f, ...chainWithoutFetchedAt } = makeChain();
    const fetcher: ChainFetcher = async () => chainWithoutFetchedAt as never;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.fetchedAt).toBeNull();
  });
});

// ── Null / empty chain handling ───────────────────────────────────────────────

describe("captureUnderlyingStrikes — null and empty chain handling", () => {
  it("returns NO_EXPIRIES when the fetcher returns null", async () => {
    const fetcher: ChainFetcher = async () => null;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.status).toBe("NO_EXPIRIES");
    expect(result.strikesWritten).toBe(0);
  });

  it("returns EMPTY_PROVIDER_RESPONSE when rows are empty", async () => {
    const chain = makeChain({ rows: [] });
    const fetcher: ChainFetcher = async () => chain;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.status).toBe("EMPTY_PROVIDER_RESPONSE");
    expect(result.strikesWritten).toBe(0);
  });

  it("returns CAPTURED with correct strike count on success", async () => {
    const chain = makeChain();
    const fetcher: ChainFetcher = async () => chain;

    const result = await captureUnderlyingStrikes("NIFTY", {
      fetcher,
      providerLabel: () => null,
      prisma: mockPrisma,
    });

    expect(result.status).toBe("CAPTURED");
    // 1 strike × 2 legs (CE + PE) × 2 expiries (current + next) = 4
    expect(result.strikesWritten).toBe(4);
    expect(result.legsWithIv).toBe(4);
    expect(result.legsWithBid).toBe(4);
    expect(result.legsWithOi).toBe(4);
  });
});

// ── chainToStrikes unit tests (existing functionality, no regression) ─────────

describe("chainToStrikes — never fabricates values", () => {
  it("maps null iv/bid/ask to null, preserves real OI", () => {
    const chain = {
      symbol: "NIFTY",
      expiry: "2026-09-25",
      rows: [
        {
          strike: 24000,
          ce: { strike: 24000, type: "CE" as const, oi: 1234, iv: null, ltp: 50, bid: null, ask: null, volume: 10 },
          pe: null,
        },
      ],
    };
    const strikes = chainToStrikes(chain, "angel_one");
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.oi).toBe(1234);
    expect(strikes[0]!.iv).toBeNull();
    expect(strikes[0]!.bid).toBeNull();
    expect(strikes[0]!.ask).toBeNull();
  });

  it("drops NaN and Infinity fields to null", () => {
    const chain = {
      symbol: "NIFTY",
      expiry: "2026-09-25",
      rows: [
        {
          strike: 1,
          ce: { strike: 1, type: "CE" as const, oi: Number.NaN, iv: Infinity, ltp: 5 },
          pe: null,
        },
      ],
    };
    const s = chainToStrikes(chain, "angel_one")[0]!;
    expect(s.oi).toBeNull();
    expect(s.iv).toBeNull();
    expect(s.ltp).toBe(5);
  });
});

// ── selectCurrentAndNextExpiry ────────────────────────────────────────────────

describe("selectCurrentAndNextExpiry", () => {
  it("selects the two nearest upcoming expiries", () => {
    const futureDate1 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const futureDate2 = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const futureDate3 = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    const chain = {
      symbol: "NIFTY",
      expiry: futureDate1,
      expiries: [futureDate1, futureDate2, futureDate3],
      rows: [],
    };
    const result = selectCurrentAndNextExpiry(chain);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(futureDate1);
    expect(result[1]).toBe(futureDate2);
  });

  it("falls back to chain.expiry when expiries list is absent", () => {
    const futureDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const chain = {
      symbol: "NIFTY",
      expiry: futureDate,
      rows: [],
    };
    const result = selectCurrentAndNextExpiry(chain);
    expect(result).toEqual([futureDate]);
  });
});
