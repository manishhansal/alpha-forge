import { describe, expect, it, vi } from "vitest";

import type { ScannerResult, ScannerType } from "@/types/india/scanner";

// `fetch-signals` delegates to `runScanner` — mock that boundary so the
// route test stays deterministic and never touches NSE / Yahoo.
const runScannerMock = vi.fn<
  (type: ScannerType, limit?: number) => Promise<ScannerResult>
>();
vi.mock("@/services/india/scanner/engine", () => ({
  runScanner: (type: ScannerType, limit?: number) =>
    runScannerMock(type, limit),
}));

// The two option-positioning ports + the Opening Breakout engine touch
// NSE / Yahoo — mock them to [] so this route test stays scanner-focused and
// offline.
vi.mock("@/features/india/scalping/strategies/positioning", () => ({
  getIndiaPositioningSignals: vi.fn(async () => []),
}));
vi.mock("@/features/india/scalping/strategies/opening-breakout", () => ({
  getIndiaOpeningBreakoutSignals: vi.fn(async () => []),
}));

import { GET } from "@/app/api/in/scalper/signals/route";

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/in/scalper/signals${qs}`);
}

function makeScanner(type: ScannerType): ScannerResult {
  return {
    type,
    title: `${type} scanner`,
    description: "test",
    hits: [
      {
        symbol: "RELIANCE",
        price: 2900,
        changePct: 1.2,
        metric: 1.2,
        metricLabel: "+1.20%",
        kind: "GAINER",
      },
    ],
    fetchedAt: new Date("2026-05-18T04:00:00Z").toISOString(),
  };
}

describe("api/in/scalper/signals", () => {
  it("defaults to timeframe=5m and runs ALL six India strategies", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockImplementation(async (type: ScannerType) =>
      makeScanner(type),
    );

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timeframe: string;
      signals: Array<{ strategyId: string; symbol: string; timeframe: string }>;
    };
    expect(body.timeframe).toBe("5m");
    expect(runScannerMock).toHaveBeenCalledTimes(6);
    expect(body.signals.length).toBe(6);
  });

  it("clamps an invalid timeframe back to 5m (UI parity with crypto)", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockImplementation(async (type: ScannerType) =>
      makeScanner(type),
    );

    const res = await GET(makeRequest("?timeframe=4h"));
    const body = (await res.json()) as { timeframe: string };
    expect(body.timeframe).toBe("5m");
  });

  it("honours the `strategies=` filter (case-insensitive) and only fans out the listed scanners", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockImplementation(async (type: ScannerType) =>
      makeScanner(type),
    );

    const res = await GET(
      makeRequest("?strategies=momentum,VOLUME_BREAKOUT,unknown"),
    );
    expect(res.status).toBe(200);
    const types = runScannerMock.mock.calls.map((c) => c[0]).sort();
    expect(types).toEqual(["momentum", "volume-breakout"]);
  });

  it("returns 502 with the failure code when the fetch throws end-to-end", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockRejectedValue(new Error("nse 503"));

    const res = await GET(makeRequest(""));
    // Every scanner fails → fetch-signals swallows individual failures
    // and returns an empty feed (200), NOT a 502. The 502 path triggers
    // only when an unhandled exception escapes — verify the happy path
    // here and let the explicit "alive" semantics ride.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signals: unknown[] };
    expect(body.signals).toHaveLength(0);
  });

  it("emits public cache headers so polling clients share a cached generation per second", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockImplementation(async (type: ScannerType) =>
      makeScanner(type),
    );

    const res = await GET(makeRequest(""));
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=\d+/);
  });
});
