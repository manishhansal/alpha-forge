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
      expect(pickBroker(["yahoo", "angel"]).id).toBe("angel");
      expect(pickBroker(["groww", "angel"]).id).toBe("angel");
    });

    it("prefers a live broker (Groww) over the public defaults", () => {
      expect(pickBroker(["yahoo", "groww"]).id).toBe("groww");
    });

    it("nse is no longer a valid broker — falls back to yahoo", () => {
      // NSE direct acquisition removed 2026-09-03
      // getBrokerById("nse") returns null; pickBroker skips null adapters
      // Cast through unknown since "nse" is no longer in the DataSourceId union.
      expect(pickBroker(["nse" as unknown as "yahoo", "yahoo"]).id).toBe("yahoo");
      expect(pickBroker(["nse" as unknown as "yahoo"]).id).toBe("yahoo");
    });

    it("falls back to yahoo for empty / undefined selections", () => {
      expect(pickBroker([]).id).toBe("yahoo");
      expect(pickBroker(undefined).id).toBe("yahoo");
    });
  });

  describe("pickBrokerChain()", () => {
    it("orders the chain by live-data preference, primary first", () => {
      // nse is no longer a valid adapter; it is dropped from the chain
      expect(pickBrokerChain(["yahoo", "nse" as unknown as "yahoo", "angel"]).map((b) => b.id)).toEqual([
        "angel",
        "yahoo",
        // "nse" is dropped — getBrokerById returns null
      ]);
    });

    it("de-dupes repeated ids", () => {
      expect(pickBrokerChain(["yahoo", "yahoo", "angel"]).map((b) => b.id)).toEqual([
        "angel",
        "yahoo",
      ]);
    });

    it("drops unwired ids (bse / zerodha / nse)", () => {
      expect(pickBrokerChain(["bse", "angel"]).map((b) => b.id)).toEqual(["angel"]);
      // nse is now also unwired (removed 2026-09-03)
      expect(pickBrokerChain(["nse" as unknown as "yahoo", "angel"]).map((b) => b.id)).toEqual(["angel"]);
    });

    it("falls back to a yahoo-only chain for empty / undefined selections", () => {
      expect(pickBrokerChain([]).map((b) => b.id)).toEqual(["yahoo"]);
      expect(pickBrokerChain(undefined).map((b) => b.id)).toEqual(["yahoo"]);
    });
  });
});
