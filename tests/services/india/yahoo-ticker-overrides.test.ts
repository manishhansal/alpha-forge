/**
 * Yahoo ticker override map — regression tests (RCA-003)
 *
 * Verifies that the 4 known problem NSE symbols are mapped to their correct
 * Yahoo Finance tickers, and that standard symbols still get the .NS suffix.
 *
 * Fix: RCA-003 — Yahoo ticker mapping gaps for TMPV, M&M, BAJAJ-AUTO, HYUNDAI
 */

import { describe, expect, it } from "vitest";
import { toYahooSymbol, getYahooSymbolOverrides } from "@/services/india/yahoo/index";

describe("toYahooSymbol — RCA-003 regression: Yahoo ticker override map", () => {
  it("standard NSE symbol gets .NS suffix", () => {
    expect(toYahooSymbol("RELIANCE")).toBe("RELIANCE.NS");
    expect(toYahooSymbol("HDFCBANK")).toBe("HDFCBANK.NS");
    expect(toYahooSymbol("TCS")).toBe("TCS.NS");
    expect(toYahooSymbol("INFY")).toBe("INFY.NS");
  });

  it("index proxies (^prefix) are returned unchanged", () => {
    expect(toYahooSymbol("^NSEI")).toBe("^NSEI");
    expect(toYahooSymbol("^NSEBANK")).toBe("^NSEBANK");
    expect(toYahooSymbol("^INDIAVIX")).toBe("^INDIAVIX");
  });

  it("symbols already containing a dot are returned unchanged", () => {
    expect(toYahooSymbol("RELIANCE.NS")).toBe("RELIANCE.NS");
    expect(toYahooSymbol("MM.NS")).toBe("MM.NS");
  });

  // ── RCA-003 regression: the 4 known override symbols ─────────────────────

  it("TMPV → TATAMOTORS.NS (commercial vehicles, TMPV.NS does not exist on Yahoo)", () => {
    expect(toYahooSymbol("TMPV")).toBe("TATAMOTORS.NS");
  });

  it("M&M → MM.NS (ampersand stripped by Yahoo)", () => {
    expect(toYahooSymbol("M&M")).toBe("MM.NS");
  });

  it("BAJAJ-AUTO → BAJAJ-AUTO.NS (hyphen preserved)", () => {
    expect(toYahooSymbol("BAJAJ-AUTO")).toBe("BAJAJ-AUTO.NS");
  });

  it("HYUNDAI → HYUNDAI.NS (Hyundai Motor India, listed 2024)", () => {
    expect(toYahooSymbol("HYUNDAI")).toBe("HYUNDAI.NS");
  });

  it("override map contains exactly the 4 expected symbols", () => {
    const overrides = getYahooSymbolOverrides();
    const keys = Object.keys(overrides).sort();
    expect(keys).toEqual(["BAJAJ-AUTO", "HYUNDAI", "M&M", "TMPV"].sort());
  });

  it("override map values are all valid Yahoo Finance tickers (end with .NS)", () => {
    const overrides = getYahooSymbolOverrides();
    for (const [nse, yahoo] of Object.entries(overrides)) {
      expect(
        yahoo.endsWith(".NS"),
        `Override for ${nse} (${yahoo}) must end with .NS`,
      ).toBe(true);
    }
  });
});

describe("normalizer.toYahooSymbol — RCA-003 regression: override map in market-data layer", () => {
  it("M&M → MM.NS via normalizer", async () => {
    const { toYahooSymbol: normYahoo } = await import(
      "@/lib/market-data/normalizer"
    );
    expect(normYahoo("M&M")).toBe("MM.NS");
  });

  it("TMPV → TATAMOTORS.NS via normalizer", async () => {
    const { toYahooSymbol: normYahoo } = await import(
      "@/lib/market-data/normalizer"
    );
    expect(normYahoo("TMPV")).toBe("TATAMOTORS.NS");
  });

  it("standard symbol still gets .NS via normalizer", async () => {
    const { toYahooSymbol: normYahoo } = await import(
      "@/lib/market-data/normalizer"
    );
    expect(normYahoo("RELIANCE")).toBe("RELIANCE.NS");
  });
});
