import { describe, expect, it, vi } from "vitest";

const getSignalsMock = vi.fn();
vi.mock("@/features/signals/fetch-signals", () => ({
  getSignals: () => getSignalsMock(),
}));

import { GET } from "@/app/api/signals/route";

describe("api/signals", () => {
  it("returns 200 with the engine payload + cache headers", async () => {
    getSignalsMock.mockReset();
    getSignalsMock.mockResolvedValueOnce({
      generatedAt: new Date().toISOString(),
      signals: [
        { symbol: "BTCUSDT", side: "LONG", confidence: 0.7 },
      ],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^public, s-maxage=\d+/);
    const body = (await res.json()) as { signals: Array<{ symbol: string }> };
    expect(body.signals[0].symbol).toBe("BTCUSDT");
  });

  it("maps engine failures to a 502 with SIGNALS_FAILED code", async () => {
    getSignalsMock.mockReset();
    getSignalsMock.mockRejectedValueOnce(new Error("upstream down"));

    const res = await GET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: boolean; code: string; message: string };
    expect(body.error).toBe(true);
    expect(body.code).toBe("SIGNALS_FAILED");
    expect(body.message).toBe("upstream down");
  });
});
