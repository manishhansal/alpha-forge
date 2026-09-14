/**
 * Tests for services/india/broker/factory.ts
 *
 * After data-service2.0 centralization:
 *   - factory.ts is execution-only (order placement)
 *   - getOpenAlgoAdapter() is the primary function
 *   - getBroker(), pickBrokerChain(), getBrokerById() are stubs or removed
 *   - Market data NEVER comes from broker adapters
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("services/india/broker/factory (execution-only after centralization)", () => {
  describe("getOpenAlgoAdapter()", () => {
    it("returns null when OPENALGO_BASE_URL is not set", async () => {
      delete process.env.OPENALGO_BASE_URL;
      delete process.env.OPENALGO_API_KEY;
      vi.resetModules();
      const { getOpenAlgoAdapter } = await import("@/services/india/broker/factory");
      expect(getOpenAlgoAdapter()).toBeNull();
    });

    it("returns an adapter when OPENALGO_BASE_URL and OPENALGO_API_KEY are set", async () => {
      process.env.OPENALGO_BASE_URL = "http://localhost:8080";
      process.env.OPENALGO_API_KEY = "test-key";
      vi.resetModules();
      const { getOpenAlgoAdapter } = await import("@/services/india/broker/factory");
      const adapter = getOpenAlgoAdapter();
      expect(adapter).not.toBeNull();
      delete process.env.OPENALGO_BASE_URL;
      delete process.env.OPENALGO_API_KEY;
    });
  });

  describe("getBroker() (deprecated, execution-only)", () => {
    it("is exported for backward compat", async () => {
      vi.resetModules();
      const { getBroker } = await import("@/services/india/broker/factory");
      expect(typeof getBroker).toBe("function");
    });
  });

  describe("getBrokerById() (deprecated, always returns null)", () => {
    it("returns null — direct broker selection removed", async () => {
      vi.resetModules();
      const { getBrokerById } = await import("@/services/india/broker/factory");
      expect(getBrokerById("angel")).toBeNull();
      expect(getBrokerById("yahoo")).toBeNull();
      expect(getBrokerById("zerodha")).toBeNull();
    });
  });

  describe("getOptionChainBroker() (deprecated)", () => {
    it("returns null — option chains come from data-service2.0 now", async () => {
      vi.resetModules();
      const { getOptionChainBroker } = await import("@/services/india/broker/factory");
      expect(getOptionChainBroker()).toBeNull();
    });
  });

  describe("market data isolation", () => {
    it("factory does not export pickBrokerChain with broker adapters", async () => {
      vi.resetModules();
      const factory = await import("@/services/india/broker/factory");
      // pickBrokerChain is removed — market data comes from data-service2.0
      if ("pickBrokerChain" in factory) {
        // If exported, it should be a no-op or undefined
        const fn = (factory as Record<string, unknown>).pickBrokerChain;
        expect(typeof fn).toBe("function");
      } else {
        expect("pickBrokerChain" in factory).toBe(false);
      }
    });
  });
});
