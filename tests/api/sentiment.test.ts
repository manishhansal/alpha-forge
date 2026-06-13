import { describe, expect, it, vi } from "vitest";

const getSentimentMock = vi.fn();
vi.mock("@/features/sentiment/fetch-sentiment", () => ({
  getSentiment: () => getSentimentMock(),
}));

import { GET } from "@/app/api/sentiment/route";

describe("api/sentiment", () => {
  it("returns 200 with the engine's payload + cache headers on success", async () => {
    getSentimentMock.mockReset();
    getSentimentMock.mockResolvedValueOnce({
      score: 62,
      verdict: "GREEDY",
      asOf: new Date().toISOString(),
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^public, s-maxage=\d+/);

    const body = (await res.json()) as { score: number; verdict: string };
    expect(body.score).toBe(62);
    expect(body.verdict).toBe("GREEDY");
  });

  it("maps engine failures to a 502 with a SENTIMENT_FAILED code", async () => {
    getSentimentMock.mockReset();
    getSentimentMock.mockRejectedValueOnce(new Error("alt.me 503"));

    const res = await GET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: boolean; code: string; message: string };
    expect(body.error).toBe(true);
    expect(body.code).toBe("SENTIMENT_FAILED");
    expect(body.message).toBe("alt.me 503");
  });
});
