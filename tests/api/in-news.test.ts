import { describe, expect, it, vi } from "vitest";
import type { GetIndiaNewsOptions } from "@/services/india/news";
import type { NewsFeedResponse } from "@/types/india/news";

// ---------------------------------------------------------------------------
// Mock the service boundary so the route test never reaches SentinelPulse.
// ---------------------------------------------------------------------------
const getIndiaNewsMock =
  vi.fn<(opts?: GetIndiaNewsOptions) => Promise<NewsFeedResponse>>();

vi.mock("@/services/india/news", () => ({
  getIndiaNews: (opts?: GetIndiaNewsOptions) => getIndiaNewsMock(opts),
}));

import { GET } from "@/app/api/in/news/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/in/news${qs}`);
}

function sampleResponse(
  partial: Partial<NewsFeedResponse> = {},
): NewsFeedResponse {
  return {
    sentiment: {
      label: "bullish",
      score: 30,
      riskRatio: 65,
      regime: "risk-on",
      bullCount: 3,
      bearCount: 1,
      headline:
        "Headlines skew bullish — risk-on tape (3 bullish / 1 bearish).",
      breadth: null,
      confidence: null,
    },
    items: [],
    fetchedAt: new Date().toISOString(),
    nextCursor: null,
    total: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/in/news", () => {
  it("defaults to category=all, limit=40 when no params are given", async () => {
    getIndiaNewsMock.mockReset().mockResolvedValueOnce(sampleResponse());
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as NewsFeedResponse;
    expect(body.sentiment.label).toBe("bullish");
    expect(getIndiaNewsMock).toHaveBeenCalledWith({
      category: "all",
      limit: 40,
      cursor: undefined,
      asset_id: undefined,
      min_importance: undefined,
      event_type: undefined,
    });
  });

  it("rejects an unknown category with 400 and a `valid` list", async () => {
    getIndiaNewsMock.mockReset();
    const res = await GET(makeRequest("?category=mars"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; valid: string[] };
    expect(body.error).toMatch(/category/i);
    expect(body.valid).toContain("india");
    expect(getIndiaNewsMock).not.toHaveBeenCalled();
  });

  it("passes a valid category and clamps limit to [1, 100]", async () => {
    getIndiaNewsMock.mockReset().mockResolvedValue(sampleResponse());
    await GET(makeRequest("?category=global&limit=0"));
    await GET(makeRequest("?category=india&limit=9999"));
    expect(getIndiaNewsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ category: "global", limit: 1 }),
    );
    expect(getIndiaNewsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ category: "india", limit: 100 }),
    );
  });

  it("forwards asset_id, min_importance, event_type to the service", async () => {
    getIndiaNewsMock.mockReset().mockResolvedValueOnce(sampleResponse());
    await GET(
      makeRequest(
        "?asset_id=RELIANCE&min_importance=0.7&event_type=CENTRAL_BANK_DECISION",
      ),
    );
    expect(getIndiaNewsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: "RELIANCE",
        min_importance: 0.7,
        event_type: "CENTRAL_BANK_DECISION",
      }),
    );
  });

  it("clamps min_importance to [0, 1]", async () => {
    getIndiaNewsMock.mockReset().mockResolvedValue(sampleResponse());
    await GET(makeRequest("?min_importance=-5"));
    await GET(makeRequest("?min_importance=99"));
    expect(getIndiaNewsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ min_importance: 0 }),
    );
    expect(getIndiaNewsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ min_importance: 1 }),
    );
  });

  it("forwards Cache-Control: no-store on success", async () => {
    getIndiaNewsMock.mockReset().mockResolvedValueOnce(sampleResponse());
    const res = await GET(makeRequest(""));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 502 with the service error message when getIndiaNews throws", async () => {
    getIndiaNewsMock
      .mockReset()
      .mockRejectedValueOnce(new Error("SentinelPulse unreachable"));
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SentinelPulse unreachable");
  });

  it("returns the nextCursor and total fields from the service response", async () => {
    getIndiaNewsMock
      .mockReset()
      .mockResolvedValueOnce(
        sampleResponse({ nextCursor: "abc123", total: 250 }),
      );
    const res = await GET(makeRequest(""));
    const body = (await res.json()) as NewsFeedResponse;
    expect(body.nextCursor).toBe("abc123");
    expect(body.total).toBe(250);
  });
});
