import { describe, expect, it } from "vitest";

import { CRYPTO_NAV, INDIA_NAV } from "@/components/dashboard/sidebar";

/**
 * Sidebar parity contract — the two NAV arrays are the source of truth
 * the live <Sidebar /> renders from, so testing them directly avoids
 * having to stand up the full Next App Router runtime (the rendered
 * sidebar reaches for `usePathname()` + the AppRouterContext via the
 * embedded MarketSwitcher).
 *
 * The split between "Strategies" (live config + signals) and "Paper
 * Trading" (open positions + journal + perf) is a hard product
 * requirement: it lets the user own each workflow on its own surface
 * without losing market-aware routing.
 */
describe("components/dashboard/sidebar — Strategies + Paper Trading split", () => {
  describe("Crypto NAV", () => {
    it("includes a Strategies item routed at /strategies", () => {
      const item = CRYPTO_NAV.find((n) => n.label === "Strategies");
      expect(item).toBeDefined();
      expect(item?.href).toBe("/strategies");
    });

    it("includes a Paper Trading item routed at /paper-trading", () => {
      const item = CRYPTO_NAV.find((n) => n.label === "Paper Trading");
      expect(item).toBeDefined();
      expect(item?.href).toBe("/paper-trading");
    });

    it("does not include the legacy Scalper item", () => {
      expect(CRYPTO_NAV.find((n) => n.label === "Scalper")).toBeUndefined();
      expect(CRYPTO_NAV.find((n) => n.href === "/scalper")).toBeUndefined();
    });

    it("orders Strategies immediately before Paper Trading", () => {
      const labels = CRYPTO_NAV.map((n) => n.label);
      const sIdx = labels.indexOf("Strategies");
      const pIdx = labels.indexOf("Paper Trading");
      expect(sIdx).toBeGreaterThanOrEqual(0);
      expect(pIdx).toBe(sIdx + 1);
    });
  });

  describe("India NAV", () => {
    it("includes a Strategies item routed at /in/strategies", () => {
      const item = INDIA_NAV.find((n) => n.label === "Strategies");
      expect(item).toBeDefined();
      expect(item?.href).toBe("/in/strategies");
    });

    it("includes a Paper Trading item routed at /in/paper-trading", () => {
      const item = INDIA_NAV.find((n) => n.label === "Paper Trading");
      expect(item).toBeDefined();
      expect(item?.href).toBe("/in/paper-trading");
    });

    it("does not include the legacy Scalper item", () => {
      expect(INDIA_NAV.find((n) => n.label === "Scalper")).toBeUndefined();
      expect(INDIA_NAV.find((n) => n.href === "/in/scalper")).toBeUndefined();
    });

    it("orders Strategies immediately before Paper Trading", () => {
      const labels = INDIA_NAV.map((n) => n.label);
      const sIdx = labels.indexOf("Strategies");
      const pIdx = labels.indexOf("Paper Trading");
      expect(sIdx).toBeGreaterThanOrEqual(0);
      expect(pIdx).toBe(sIdx + 1);
    });
  });

  describe("India News surface", () => {
    it("includes a News item routed at /in/news", () => {
      const item = INDIA_NAV.find((n) => n.label === "News");
      expect(item).toBeDefined();
      expect(item?.href).toBe("/in/news");
    });

    it("keeps News protected (not a public showroom surface)", () => {
      const item = INDIA_NAV.find((n) => n.href === "/in/news");
      expect(item?.public).toBeUndefined();
    });

    it("orders News after Heatmap among the India-only extras", () => {
      const labels = INDIA_NAV.map((n) => n.label);
      expect(labels.indexOf("News")).toBeGreaterThan(labels.indexOf("Heatmap"));
    });
  });

  it("Strategies + Paper Trading sit at the same index in both markets (sidebar parity)", () => {
    const crypto = CRYPTO_NAV.map((n) => n.label);
    const india = INDIA_NAV.map((n) => n.label);
    expect(crypto.indexOf("Strategies")).toBe(india.indexOf("Strategies"));
    expect(crypto.indexOf("Paper Trading")).toBe(india.indexOf("Paper Trading"));
  });
});
