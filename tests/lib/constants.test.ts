import { describe, expect, it } from "vitest";

import {
  brokerPairToSymbolId,
  CACHE_TTL_SECONDS,
  LIQUIDATION_BUFFER_TTL_SECONDS,
  LIQUIDATION_WINDOW_MS,
  REDIS_KEYS,
  SYMBOLS_BY_BINANCE,
  TRACKED_SYMBOLS,
} from "@/lib/constants";

describe("lib/constants", () => {
  describe("TRACKED_SYMBOLS", () => {
    it("contains BTC, ETH, SOL exactly once each", () => {
      const ids = TRACKED_SYMBOLS.map((s) => s.id);
      expect(ids).toEqual(["BTC", "ETH", "SOL"]);
    });

    it("publishes both binance and delta broker pairs", () => {
      for (const meta of TRACKED_SYMBOLS) {
        expect(meta.brokers.binance.spot).toMatch(/USDT$/);
        expect(meta.brokers.delta.spot).toMatch(/USD$/);
      }
    });
  });

  describe("SYMBOLS_BY_BINANCE", () => {
    it("indexes by the Binance spot pair", () => {
      expect(SYMBOLS_BY_BINANCE.BTCUSDT?.id).toBe("BTC");
      expect(SYMBOLS_BY_BINANCE.ETHUSDT?.id).toBe("ETH");
      expect(SYMBOLS_BY_BINANCE.SOLUSDT?.id).toBe("SOL");
    });

    it("returns undefined for unknown pairs", () => {
      expect(SYMBOLS_BY_BINANCE.DOGEUSDT).toBeUndefined();
    });
  });

  describe("brokerPairToSymbolId()", () => {
    it("resolves Binance pairs", () => {
      expect(brokerPairToSymbolId("binance", "BTCUSDT")).toBe("BTC");
      expect(brokerPairToSymbolId("binance", "ETHUSDT")).toBe("ETH");
    });

    it("resolves Delta India pairs (no T suffix)", () => {
      expect(brokerPairToSymbolId("delta", "BTCUSD")).toBe("BTC");
      expect(brokerPairToSymbolId("delta", "ETHUSD")).toBe("ETH");
      expect(brokerPairToSymbolId("delta", "SOLUSD")).toBe("SOL");
    });

    it("returns null for unknown pairs", () => {
      expect(brokerPairToSymbolId("binance", "FAKEUSDT")).toBeNull();
      expect(brokerPairToSymbolId("delta", "FAKEUSD")).toBeNull();
    });

    it("does not cross brokers — Binance pair is not a Delta pair", () => {
      // BTCUSDT is a Binance pair; Delta uses BTCUSD.
      expect(brokerPairToSymbolId("delta", "BTCUSDT")).toBeNull();
    });
  });

  describe("REDIS_KEYS", () => {
    it("publishes stable string keys for the static buckets", () => {
      expect(REDIS_KEYS.marketOverview).toMatch(/^market:overview/);
      expect(REDIS_KEYS.signals).toMatch(/^signals:engine/);
    });

    it("scopes liquidation buffer keys per pair", () => {
      expect(REDIS_KEYS.liquidationBuffer("BTCUSDT")).toContain("BTCUSDT");
      expect(REDIS_KEYS.liquidationBuffer("ETHUSDT")).toContain("ETHUSDT");
      expect(REDIS_KEYS.liquidationBuffer("BTCUSDT")).not.toEqual(
        REDIS_KEYS.liquidationBuffer("ETHUSDT"),
      );
    });

    it("scopes alert cooldown keys per alert id", () => {
      expect(REDIS_KEYS.alertCooldown("alert-1")).toContain("alert-1");
      expect(REDIS_KEYS.alertCooldown("alert-1")).not.toEqual(
        REDIS_KEYS.alertCooldown("alert-2"),
      );
    });

    it("scopes scalper last-trade keys per (symbol, timeframe) pair", () => {
      const k = REDIS_KEYS.scalperLastTrade("BTCUSDT", "5m");
      expect(k).toContain("BTCUSDT");
      expect(k).toContain("5m");
    });
  });

  describe("CACHE_TTL_SECONDS", () => {
    it("publishes positive integer TTLs only", () => {
      for (const [k, v] of Object.entries(CACHE_TTL_SECONDS)) {
        expect(v, `${k}`).toBeGreaterThan(0);
        expect(Number.isInteger(v), `${k}`).toBe(true);
      }
    });
  });

  describe("liquidation window constants", () => {
    it("LIQUIDATION_WINDOW_MS = 5 minutes", () => {
      expect(LIQUIDATION_WINDOW_MS).toBe(5 * 60 * 1000);
    });

    it("LIQUIDATION_BUFFER_TTL_SECONDS is a safety net larger than the window", () => {
      expect(LIQUIDATION_BUFFER_TTL_SECONDS * 1000).toBeGreaterThan(LIQUIDATION_WINDOW_MS);
    });
  });
});
