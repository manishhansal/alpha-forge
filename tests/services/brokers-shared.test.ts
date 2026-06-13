import { describe, expect, it } from "vitest";

import {
  getActiveBrokerIdShared,
  getBrokerDisplayName,
  getBrokerPair,
} from "@/services/brokers/shared";

describe("services/brokers/shared", () => {
  describe("getActiveBrokerIdShared()", () => {
    it("returns the configured broker id ('delta' default)", () => {
      const id = getActiveBrokerIdShared();
      expect(["binance", "delta"]).toContain(id);
    });
  });

  describe("getBrokerDisplayName()", () => {
    it("renders human labels for both supported brokers", () => {
      expect(getBrokerDisplayName("binance")).toBe("Binance");
      expect(getBrokerDisplayName("delta")).toBe("Delta Exchange India");
    });

    it("falls back to the active broker when no id is given", () => {
      const label = getBrokerDisplayName();
      expect(["Binance", "Delta Exchange India"]).toContain(label);
    });
  });

  describe("getBrokerPair()", () => {
    it("resolves Binance pairs", () => {
      expect(getBrokerPair("BTC", "spot", "binance")).toBe("BTCUSDT");
      expect(getBrokerPair("ETH", "futures", "binance")).toBe("ETHUSDT");
    });

    it("resolves Delta pairs", () => {
      expect(getBrokerPair("BTC", "spot", "delta")).toBe("BTCUSD");
      expect(getBrokerPair("SOL", "futures", "delta")).toBe("SOLUSD");
    });

    it("returns empty string for unknown symbols", () => {
      // @ts-expect-error — testing the unhappy path.
      expect(getBrokerPair("DOGE", "spot", "binance")).toBe("");
    });
  });
});
