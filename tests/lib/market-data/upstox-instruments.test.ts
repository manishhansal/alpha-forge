// @vitest-environment node
/**
 * Regression tests for the Upstox instrument-master ISIN resolver.
 *
 * Guards the real bug found during live validation: Upstox rejects
 * symbol-based equity keys (NSE_EQ|RELIANCE → HTTP 400 "Invalid Instrument key")
 * and requires the ISIN-based key (NSE_EQ|INE002A01018). The resolver must:
 *   - decode the RAW-gzip instrument master (Content-Type: application/gzip,
 *     NO Content-Encoding) rather than assuming fetch auto-decompresses,
 *   - map trading_symbol → ISIN instrument_key for EQ rows only,
 *   - return null for unknown symbols so the caller can fall back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

import {
  resolveEquityInstrumentKey,
  _resetUpstoxInstrumentCache,
} from "@/lib/market-data/providers/upstox-instruments";
import {
  resolveUpstoxInstrumentKey,
  toUpstoxInstrumentKey,
} from "@/lib/market-data/providers/upstox";
import { cache } from "@/services/india/cache";

const MASTER_ROWS = [
  {
    segment: "NSE_EQ",
    instrument_type: "EQ",
    trading_symbol: "RELIANCE",
    isin: "INE002A01018",
    instrument_key: "NSE_EQ|INE002A01018",
    exchange: "NSE",
  },
  {
    segment: "NSE_EQ",
    instrument_type: "EQ",
    trading_symbol: "HDFCBANK",
    isin: "INE040A01034",
    instrument_key: "NSE_EQ|INE040A01034",
    exchange: "NSE",
  },
  // A non-equity row that must be ignored (bond/SG).
  {
    segment: "NSE_EQ",
    instrument_type: "SG",
    trading_symbol: "749RJ35",
    isin: "IN2920250163",
    instrument_key: "NSE_EQ|IN2920250163",
    exchange: "NSE",
  },
  // An F&O row that must be ignored by the equity map.
  {
    segment: "NSE_FO",
    instrument_type: "PE",
    trading_symbol: "NIFTY 24000 PE",
    instrument_key: "NSE_FO|50917",
    exchange: "NSE",
  },
];

/** Build a mock Response that serves RAW gzip bytes, like the real endpoint. */
function gzipResponse(rows: unknown): Response {
  const body = gzipSync(Buffer.from(JSON.stringify(rows)));
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/gzip" : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

describe("Upstox instrument-master resolver", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await _resetUpstoxInstrumentCache();
    await cache.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(gzipResponse(MASTER_ROWS));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await _resetUpstoxInstrumentCache();
  });

  it("decodes the raw-gzip master and resolves equity symbol → ISIN key", async () => {
    expect(await resolveEquityInstrumentKey("RELIANCE", "NSE")).toBe("NSE_EQ|INE002A01018");
    expect(await resolveEquityInstrumentKey("HDFCBANK", "NSE")).toBe("NSE_EQ|INE040A01034");
  });

  it("ignores non-EQ rows (bonds, F&O)", async () => {
    // 749RJ35 is an SG row; must not resolve as an equity.
    expect(await resolveEquityInstrumentKey("749RJ35", "NSE")).toBeNull();
  });

  it("returns null for unknown symbols (caller falls back)", async () => {
    expect(await resolveEquityInstrumentKey("NOTAREALSYMBOL", "NSE")).toBeNull();
  });

  it("downloads the master only once (cached across calls)", async () => {
    await resolveEquityInstrumentKey("RELIANCE", "NSE");
    await resolveEquityInstrumentKey("HDFCBANK", "NSE");
    await resolveEquityInstrumentKey("RELIANCE", "NSE");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first-time resolutions into one download", async () => {
    const [a, b, c] = await Promise.all([
      resolveEquityInstrumentKey("RELIANCE", "NSE"),
      resolveEquityInstrumentKey("HDFCBANK", "NSE"),
      resolveEquityInstrumentKey("RELIANCE", "NSE"),
    ]);
    expect(a).toBe("NSE_EQ|INE002A01018");
    expect(b).toBe("NSE_EQ|INE040A01034");
    expect(c).toBe("NSE_EQ|INE002A01018");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveUpstoxInstrumentKey (provider wiring)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await _resetUpstoxInstrumentCache();
    await cache.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(gzipResponse(MASTER_ROWS));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await _resetUpstoxInstrumentCache();
  });

  it("resolves NSE equities to the ISIN key (the fix)", async () => {
    expect(await resolveUpstoxInstrumentKey("RELIANCE", "NSE")).toBe("NSE_EQ|INE002A01018");
  });

  it("keeps indices as name-based keys (no master lookup)", async () => {
    expect(await resolveUpstoxInstrumentKey("NIFTY", "NSE")).toBe("NSE_INDEX|Nifty 50");
    expect(await resolveUpstoxInstrumentKey("BANKNIFTY", "NSE")).toBe("NSE_INDEX|Nifty Bank");
  });

  it("keeps F&O keys in the segment form (no master lookup)", async () => {
    expect(await resolveUpstoxInstrumentKey("NIFTY24000CE", "NFO")).toBe("NSE_FO|NIFTY24000CE");
  });

  it("falls back to the symbol form when the master is unavailable", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    // Unknown-to-master equity → resolver returns the sync fallback shape.
    const key = await resolveUpstoxInstrumentKey("SOMEEQUITY", "NSE");
    expect(key).toBe(toUpstoxInstrumentKey("SOMEEQUITY", "NSE"));
    expect(key).toBe("NSE_EQ|SOMEEQUITY");
  });
});
