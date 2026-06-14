import { afterEach, describe, expect, it } from "vitest";

import {
  getBroker,
  getBrokerById,
  pickBroker,
  pickBrokerChain,
} from "@/services/india/broker/factory";

const ORIGINAL = process.env.INDIA_BROKER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INDIA_BROKER;
  else process.env.INDIA_BROKER = ORIGINAL;
});

describe("services/india/broker/factory", () => {
  describe("getBrokerById()", () => {
    it("resolves the Angel One adapter", () => {
      expect(getBrokerById("angel")?.id).toBe("angel");
    });

    it("returns null for unwired ids", () => {
      expect(getBrokerById("zerodha")).toBeNull();
    });
  });

  describe("getBroker()", () => {
    it("selects Angel One when INDIA_BROKER=angel", () => {
      process.env.INDIA_BROKER = "angel";
      expect(getBroker().id).toBe("angel");
    });

    it("defaults to yahoo when unset", () => {
      delete process.env.INDIA_BROKER;
      delete process.env.BROKER;
      expect(getBroker().id).toBe("yahoo");
    });
  });

  describe("pickBroker()", () => {
    it("prefers Angel One when it is among the selected sources", () => {
      expect(pickBroker(["yahoo", "nse", "angel"]).id).toBe("angel");
      expect(pickBroker(["groww", "angel"]).id).toBe("angel");
    });

    it("prefers a live broker (Groww) over the public defaults", () => {
      expect(pickBroker(["yahoo", "groww"]).id).toBe("groww");
    });

    it("preserves the existing order among equal-priority public sources", () => {
      expect(pickBroker(["yahoo", "nse"]).id).toBe("yahoo");
      expect(pickBroker(["nse", "yahoo"]).id).toBe("nse");
    });

    it("falls back to yahoo for empty / undefined selections", () => {
      expect(pickBroker([]).id).toBe("yahoo");
      expect(pickBroker(undefined).id).toBe("yahoo");
    });
  });

  describe("pickBrokerChain()", () => {
    it("orders the chain by live-data preference, primary first", () => {
      expect(pickBrokerChain(["yahoo", "nse", "angel"]).map((b) => b.id)).toEqual([
        "angel",
        "yahoo",
        "nse",
      ]);
    });

    it("de-dupes repeated ids", () => {
      expect(pickBrokerChain(["yahoo", "yahoo", "angel"]).map((b) => b.id)).toEqual([
        "angel",
        "yahoo",
      ]);
    });

    it("drops unwired ids (bse / zerodha)", () => {
      expect(pickBrokerChain(["bse", "angel"]).map((b) => b.id)).toEqual(["angel"]);
    });

    it("falls back to a yahoo-only chain for empty / undefined selections", () => {
      expect(pickBrokerChain([]).map((b) => b.id)).toEqual(["yahoo"]);
      expect(pickBrokerChain(undefined).map((b) => b.id)).toEqual(["yahoo"]);
    });
  });
});
