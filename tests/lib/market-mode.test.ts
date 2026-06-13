import { describe, expect, it } from "vitest";

import { marketFromPath } from "@/lib/market-mode";

describe("lib/market-mode", () => {
  describe("marketFromPath()", () => {
    it("treats `null` and `undefined` as crypto", () => {
      expect(marketFromPath(null)).toBe("crypto");
      expect(marketFromPath(undefined)).toBe("crypto");
    });

    it("returns 'india' for the bare /in landing route", () => {
      expect(marketFromPath("/in")).toBe("india");
    });

    it("returns 'india' for nested /in/* routes", () => {
      expect(marketFromPath("/in/dashboard")).toBe("india");
      expect(marketFromPath("/in/options")).toBe("india");
      expect(marketFromPath("/in/scanner/RELIANCE")).toBe("india");
    });

    it("returns 'crypto' for the root path", () => {
      expect(marketFromPath("/")).toBe("crypto");
    });

    it("returns 'crypto' for non-/in paths", () => {
      expect(marketFromPath("/futures")).toBe("crypto");
      expect(marketFromPath("/scalper")).toBe("crypto");
      expect(marketFromPath("/strategies")).toBe("crypto");
      expect(marketFromPath("/paper-trading")).toBe("crypto");
      expect(marketFromPath("/strategy-lab")).toBe("crypto");
    });

    it("returns 'india' for the new India strategies + paper-trading routes", () => {
      expect(marketFromPath("/in/strategies")).toBe("india");
      expect(marketFromPath("/in/paper-trading")).toBe("india");
    });

    it("does NOT treat /information or /individual as the india market", () => {
      // Guards against accidental prefix-match bugs.
      expect(marketFromPath("/information")).toBe("crypto");
      expect(marketFromPath("/individual")).toBe("crypto");
      expect(marketFromPath("/inn")).toBe("crypto");
    });

    it("treats the empty string as crypto", () => {
      expect(marketFromPath("")).toBe("crypto");
    });
  });
});
