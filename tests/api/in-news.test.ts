import { describe, expect, it, vi } from "vitest";

import type { GetIndiaNewsOptions } from "@/services/india/news";
import type { NewsFeedResponse } from "@/types/india/news";

// Mock the service boundary so the route test stays deterministic and never
// reaches the network.
const getIndiaNewsMock =
  vi.fn<(opts?: GetIndiaNewsOptions) => Promise<NewsFeedResponse>>();
vi.mock("@/services/india/news", () => ({
  getIndiaNews: (opts?: GetIndiaNewsOptions) => getIndiaNewsMock(opts),
}));

import { GET } from "@/app/api/in/news/route";

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/in/news${qs}`);
}

function sampleResponse(): NewsFeedResponse {
  return {
    sentiment: {
      label: "bullish",
      score: 30,
      riskRatio: 65,
      regime: "risk-on",
      bullCount: 3,
      bearCount: 1,
      headline: "Headlines skew bullish — risk-on tape (3 bullish / 1 bearish).",
    },
    items: [],
    fetchedAt: new Date().toISOString(),
  };
}

describe("api/in/news", () => {
  it("defaults to category=all with a clamped limit when no params are given", async () => {
    getIndiaNewsMock.mockReset();
    getIndiaNewsMock.mockResolvedValueOnce(sampleResponse());

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as NewsFeedResponse;
    expect(body.sentiment.label).toBe("bullish");
    expect(getIndiaNewsMock).toHaveBeenCalledWith({ category: "all", limit: 40 });
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

  it("passes a valid category through and clamps limit into [5, 100]", async () => {
    getIndiaNewsMock.mockReset();
    getIndiaNewsMock.mockResolvedValue(sampleResponse());

    await GET(makeRequest("?category=global&limit=1"));
    await GET(makeRequest("?category=india&limit=9999"));

    expect(getIndiaNewsMock).toHaveBeenNthCalledWith(1, {
      category: "global",
      limit: 5,
    });
    expect(getIndiaNewsMock).toHaveBeenNthCalledWith(2, {
      category: "india",
      limit: 100,
    });
  });

  it("forwards Cache-Control: no-store on success", async () => {
    getIndiaNewsMock.mockReset();
    getIndiaNewsMock.mockResolvedValueOnce(sampleResponse());

    const res = await GET(makeRequest(""));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 502 with the service error message when getIndiaNews throws", async () => {
    getIndiaNewsMock.mockReset();
    getIndiaNewsMock.mockRejectedValueOnce(new Error("feeds unreachable"));

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("feeds unreachable");
  });
});
