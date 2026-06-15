import { describe, expect, it } from "vitest";

import {
  atmStrike,
  buildIndexExpiryTrades,
  estimateAtmPremium,
  isExpiryDayFromChain,
  istWeekday,
  optionTypeFromBias,
  otmStrike,
  parseExpiryToDateKey,
} from "@/features/india/expiry-trades/engine";

describe("expiry-trades engine", () => {
  describe("parseExpiryToDateKey", () => {
    it("parses DD-MMM-YYYY into an ISO date key", () => {
      expect(parseExpiryToDateKey("16-JUN-2026")).toBe("2026-06-16");
      expect(parseExpiryToDateKey("02-Jan-2026")).toBe("2026-01-02");
    });
    it("returns null on malformed input", () => {
      expect(parseExpiryToDateKey("nonsense")).toBeNull();
      expect(parseExpiryToDateKey("")).toBeNull();
      expect(parseExpiryToDateKey(null)).toBeNull();
    });
  });

  describe("isExpiryDayFromChain", () => {
    it("is true only when the chain expiry resolves to the trade date", () => {
      expect(isExpiryDayFromChain("16-JUN-2026", "2026-06-16")).toBe(true);
      expect(isExpiryDayFromChain("16-JUN-2026", "2026-06-15")).toBe(false);
    });
  });

  describe("istWeekday", () => {
    it("returns Tuesday (2) for an IST Tuesday", () => {
      // 2026-06-16 is a Tuesday; 06:00Z = 11:30 IST same day.
      expect(istWeekday(new Date("2026-06-16T06:00:00Z"))).toBe(2);
    });
  });

  describe("estimateAtmPremium", () => {
    it("returns a positive premium that grows with IV", () => {
      const lo = estimateAtmPremium(23000, 10, 6);
      const hi = estimateAtmPremium(23000, 20, 6);
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeGreaterThan(lo);
    });
    it("returns 0 for an invalid spot", () => {
      expect(estimateAtmPremium(0, 12, 6)).toBe(0);
    });
  });

  describe("strike helpers", () => {
    it("rounds to the nearest ATM strike", () => {
      expect(atmStrike(23012, 50)).toBe(23000);
      expect(atmStrike(23030, 50)).toBe(23050);
    });
    it("steps OTM in the option's direction", () => {
      expect(otmStrike(23000, 50, "CE", 3)).toBe(23150);
      expect(otmStrike(23000, 50, "PE", 3)).toBe(22850);
    });
    it("maps bias sign to CE / PE", () => {
      expect(optionTypeFromBias(0.4)).toBe("CE");
      expect(optionTypeFromBias(-0.4)).toBe("PE");
    });
  });

  describe("buildIndexExpiryTrades", () => {
    it("builds a CALL gamma-blast + hero-zero on a bullish bias", () => {
      const trades = buildIndexExpiryTrades({
        index: "NIFTY",
        spot: 23010,
        bias: 0.5,
        step: 50,
        ivPct: 12,
        hoursToExpiry: 5,
        expiry: "16-JUN-2026",
        dataSource: "estimated",
      });
      expect(trades).toHaveLength(2);
      const [gb, hz] = trades;
      expect(gb.kind).toBe("GAMMA_BLAST");
      expect(gb.optionType).toBe("CE");
      expect(gb.strike).toBe(23000); // ATM
      expect(gb.target).toBeGreaterThan(gb.entryPremium);
      expect(hz.kind).toBe("HERO_ZERO");
      expect(hz.strike).toBe(23150); // 3 steps OTM
      expect(hz.stopLoss).toBe(0); // can go to zero
    });

    it("builds PUTs on a bearish bias", () => {
      const trades = buildIndexExpiryTrades({
        index: "SENSEX",
        spot: 75020,
        bias: -0.6,
        step: 100,
        ivPct: 14,
        hoursToExpiry: 4,
        expiry: "18-JUN-2026",
        dataSource: "estimated",
      });
      expect(trades.every((t) => t.optionType === "PE")).toBe(true);
      expect(trades[1].strike).toBe(75000 - 300); // 3 steps OTM PE
    });

    it("prefers live-chain premiums when supplied", () => {
      const premiumAt = (strike: number, type: string) =>
        type === "CE" && strike === 23000 ? 90 : null;
      const trades = buildIndexExpiryTrades({
        index: "NIFTY",
        spot: 23010,
        bias: 0.5,
        step: 50,
        ivPct: 12,
        hoursToExpiry: 5,
        expiry: "16-JUN-2026",
        dataSource: "chain",
        premiumAt,
      });
      const gb = trades[0];
      expect(gb.entryPremium).toBe(90); // from the chain, not the estimate
      expect(gb.target).toBe(Math.round(90 * 2.2));
    });

    it("returns nothing for an invalid spot", () => {
      expect(
        buildIndexExpiryTrades({
          index: "NIFTY",
          spot: 0,
          bias: 0.5,
          step: 50,
          ivPct: 12,
          hoursToExpiry: 5,
          expiry: "16-JUN-2026",
          dataSource: "estimated",
        }),
      ).toEqual([]);
    });
  });
});
