import { describe, expect, it } from "vitest";

import {
  DATA_SOURCES,
  DATA_SOURCES_BY_ID,
  DEFAULT_SELECTIONS,
  dataSourceLabels,
  dataSourcesFor,
  indiaSourceFooter,
  INDIA_OI_SOURCES,
  normalizeSelections,
} from "@/features/settings/data-sources-shared";
import {
  EXCHANGE_LABELS,
  EXCHANGE_MARKET,
  SAVE_INPUT_SCHEMA,
  SUPPORTED_EXCHANGES,
} from "@/features/settings/api-keys-shared";

describe("features/settings/data-sources-shared", () => {
  it("DATA_SOURCES_BY_ID indexes every entry in DATA_SOURCES", () => {
    for (const s of DATA_SOURCES) {
      expect(DATA_SOURCES_BY_ID[s.id]).toEqual(s);
    }
  });

  it("dataSourceLabels() maps ids to display labels", () => {
    expect(dataSourceLabels(["angel", "yahoo"])).toEqual([
      "Angel One SmartAPI",
      "Yahoo Finance",
    ]);
  });

  describe("indiaSourceFooter()", () => {
    it("names the primary source and notes there is no fallback when only one is selected", () => {
      const { title, sub } = indiaSourceFooter(["Angel One SmartAPI"]);
      expect(title).toBe("Live data via Angel One SmartAPI");
      expect(sub).toContain("no fallback");
    });

    it("lists every selected source when more than one is active", () => {
      const { title, sub } = indiaSourceFooter([
        "Angel One SmartAPI",
        "Yahoo Finance",
      ]);
      expect(title).toBe("Live data via Angel One SmartAPI");
      expect(sub).toContain("Angel One SmartAPI · Yahoo Finance");
    });

    it("falls back to the Yahoo default copy for an empty chain", () => {
      const { title } = indiaSourceFooter([]);
      expect(title).toBe("Live data via Yahoo Finance");
    });
  });

  it("dataSourcesFor() filters by market", () => {
    const india = dataSourcesFor("india").map((s) => s.id);
    const crypto = dataSourcesFor("crypto").map((s) => s.id);
    expect(india).toEqual(expect.arrayContaining(["yahoo", "nse", "groww"]));
    expect(crypto).toEqual(expect.arrayContaining(["binance", "delta"]));
    expect(india).not.toContain("binance");
    expect(crypto).not.toContain("yahoo");
  });

  it("INDIA_OI_SOURCES are all India-market sources", () => {
    for (const id of INDIA_OI_SOURCES) {
      expect(DATA_SOURCES_BY_ID[id].market).toBe("india");
    }
  });

  describe("normalizeSelections()", () => {
    it("returns DEFAULT_SELECTIONS for null / non-object input", () => {
      expect(normalizeSelections(null)).toEqual(DEFAULT_SELECTIONS);
      expect(normalizeSelections(42)).toEqual(DEFAULT_SELECTIONS);
      expect(normalizeSelections("foo")).toEqual(DEFAULT_SELECTIONS);
    });

    it("filters out unknown source ids", () => {
      const out = normalizeSelections({
        india: { selected: ["yahoo", "fake-source", "nse"], optionChain: "nse" },
        crypto: { selected: ["binance", "etoro"], primary: "binance" },
      });
      expect(out.india.selected).toEqual(["yahoo", "nse"]);
      expect(out.crypto.selected).toEqual(["binance"]);
    });

    it("falls back to default optionChain when invalid", () => {
      const out = normalizeSelections({
        india: { selected: ["yahoo"], optionChain: "yahoo" }, // yahoo is not OI-capable
        crypto: { selected: ["binance"], primary: "binance" },
      });
      expect(out.india.optionChain).toBe(DEFAULT_SELECTIONS.india.optionChain);
    });

    it("falls back to selected[0] when primary id is invalid", () => {
      const out = normalizeSelections({
        india: { selected: [], optionChain: "nse" },
        crypto: { selected: ["delta"], primary: "not-a-real-source" },
      });
      expect(out.crypto.primary).toBe("delta");
      expect(out.crypto.selected).toEqual(["delta"]);
    });

    it("keeps a valid explicit primary even if not in selected", () => {
      const out = normalizeSelections({
        india: { selected: [], optionChain: "nse" },
        crypto: { selected: ["delta"], primary: "binance" },
      });
      // The shared normalizer trusts a known source id for `primary` and
      // does NOT mutate `selected`. UI code is responsible for enforcing
      // membership when persisting.
      expect(out.crypto.primary).toBe("binance");
      expect(out.crypto.selected).toEqual(["delta"]);
    });

    it("dedupes the selected arrays", () => {
      const out = normalizeSelections({
        india: { selected: ["yahoo", "yahoo", "nse"], optionChain: "nse" },
        crypto: { selected: ["binance", "binance"], primary: "binance" },
      });
      expect(out.india.selected).toEqual(["yahoo", "nse"]);
      expect(out.crypto.selected).toEqual(["binance"]);
    });
  });
});

describe("features/settings/api-keys-shared", () => {
  it("publishes labels for every supported exchange", () => {
    for (const ex of SUPPORTED_EXCHANGES) {
      expect(EXCHANGE_LABELS[ex]).toBeTypeOf("string");
      expect(EXCHANGE_LABELS[ex].length).toBeGreaterThan(0);
    }
  });

  it("classifies each exchange by market", () => {
    expect(EXCHANGE_MARKET.binance).toBe("crypto");
    expect(EXCHANGE_MARKET.delta).toBe("crypto");
    expect(EXCHANGE_MARKET.bybit).toBe("crypto");
    expect(EXCHANGE_MARKET.deribit).toBe("crypto");
    expect(EXCHANGE_MARKET.groww).toBe("india");
    expect(EXCHANGE_MARKET.zerodha).toBe("india");
  });

  it("includes Angel One as an India exchange with a label", () => {
    expect(SUPPORTED_EXCHANGES).toContain("angel");
    expect(EXCHANGE_LABELS.angel).toMatch(/angel/i);
    expect(EXCHANGE_MARKET.angel).toBe("india");
  });
});

describe("features/settings/api-keys-shared SAVE_INPUT_SCHEMA", () => {
  it("accepts a crypto key with apiKey + apiSecret", () => {
    const res = SAVE_INPUT_SCHEMA.safeParse({
      exchange: "binance",
      apiKey: "publicKey123",
      apiSecret: "secretValue123",
      readOnly: true,
    });
    expect(res.success).toBe(true);
  });

  it("rejects a crypto key with a too-short apiSecret", () => {
    const res = SAVE_INPUT_SCHEMA.safeParse({
      exchange: "binance",
      apiKey: "publicKey123",
      apiSecret: "x",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.apiSecret).toBeDefined();
    }
  });

  it("accepts an Angel One key with apiKey + clientCode + pin + totpSecret (no apiSecret)", () => {
    const res = SAVE_INPUT_SCHEMA.safeParse({
      exchange: "angel",
      apiKey: "smartApiKey123",
      clientCode: "A12345",
      pin: "1234",
      totpSecret: "BASE32SECRET",
    });
    expect(res.success).toBe(true);
  });

  it("rejects an Angel One key missing clientCode / pin / totpSecret", () => {
    const res = SAVE_INPUT_SCHEMA.safeParse({
      exchange: "angel",
      apiKey: "smartApiKey123",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const errs = res.error.flatten().fieldErrors;
      expect(errs.clientCode).toBeDefined();
      expect(errs.pin).toBeDefined();
      expect(errs.totpSecret).toBeDefined();
    }
  });
});
