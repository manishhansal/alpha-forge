import { describe, expect, it } from "vitest";

import {
  FNO_INDEX_UNDERLYINGS,
  FNO_INDICES,
  FNO_OPTION_UNDERLYINGS,
  FNO_STOCKS,
  primarySector,
  SUPPLEMENTARY_INDICES,
  SYMBOL_SECTORS,
} from "@/lib/india/fno-symbols";

describe("lib/india/fno-symbols", () => {
  it("publishes the four F&O index families", () => {
    const underlyings = FNO_INDICES.map((i) => i.underlying);
    expect(underlyings).toEqual(
      expect.arrayContaining(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]),
    );
  });

  it("FNO_INDEX_UNDERLYINGS is a Set with all four indices", () => {
    expect(FNO_INDEX_UNDERLYINGS.has("NIFTY")).toBe(true);
    expect(FNO_INDEX_UNDERLYINGS.has("BANKNIFTY")).toBe(true);
    expect(FNO_INDEX_UNDERLYINGS.has("RELIANCE")).toBe(false);
  });

  it("Yahoo tickers for the indices are well-formed", () => {
    for (const idx of FNO_INDICES) {
      expect(idx.symbol.startsWith("^")).toBe(true);
    }
  });

  it("supplementary indices include SENSEX and INDIA VIX", () => {
    const names = SUPPLEMENTARY_INDICES.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["SENSEX", "INDIA VIX"]));
  });

  it("FNO_STOCKS is a sorted, deduplicated list", () => {
    const sorted = [...FNO_STOCKS].sort();
    expect(FNO_STOCKS).toEqual(sorted);
    expect(new Set(FNO_STOCKS).size).toBe(FNO_STOCKS.length);
  });

  it("FNO_OPTION_UNDERLYINGS is the union of indices + stocks", () => {
    expect(FNO_OPTION_UNDERLYINGS.length).toBe(
      FNO_INDICES.length + FNO_STOCKS.length,
    );
  });

  it("SYMBOL_SECTORS reverse map returns at least one sector per stock", () => {
    for (const sym of FNO_STOCKS.slice(0, 5)) {
      expect(SYMBOL_SECTORS[sym]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("primarySector() returns a sector for known stocks, null otherwise", () => {
    const sample = FNO_STOCKS[0];
    expect(typeof primarySector(sample)).toBe("string");
    expect(primarySector("NOT_A_REAL_STOCK_ZZZ")).toBeNull();
  });
});
