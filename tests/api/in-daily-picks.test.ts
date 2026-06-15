import { describe, expect, it, vi } from "vitest";

const getPicksMock = vi.fn();
const getHistoryMock = vi.fn();

vi.mock("@/features/india/daily-picks/builder", () => ({
  getIndiaDailyPicks: () => getPicksMock(),
  getIndiaDailyPicksHistory: (opts: unknown) => getHistoryMock(opts),
}));

import { GET as getPicks } from "@/app/api/in/daily-picks/route";
import { GET as getHistory } from "@/app/api/in/daily-picks/history/route";

describe("api/in/daily-picks", () => {
  it("returns the board payload with no-store caching", async () => {
    getPicksMock.mockReset();
    getPicksMock.mockResolvedValueOnce({
      market: "india",
      tradeDate: "2026-06-15",
      groups: [],
      persisted: true,
    });

    const res = await getPicks();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { tradeDate: string };
    expect(body.tradeDate).toBe("2026-06-15");
  });

  it("returns 502 with the engine error message when the builder throws", async () => {
    getPicksMock.mockReset();
    getPicksMock.mockRejectedValueOnce(new Error("boom"));

    const res = await getPicks();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.message).toBe("boom");
    expect(body.code).toBe("INDIA_DAILY_PICKS_FAILED");
  });
});

describe("api/in/daily-picks/history", () => {
  function makeRequest(qs: string): Request {
    return new Request(`http://localhost/api/in/daily-picks/history${qs}`);
  }

  it("parses the days query and forwards it to the builder", async () => {
    getHistoryMock.mockReset();
    getHistoryMock.mockResolvedValueOnce({ market: "india", days: [] });

    const res = await getHistory(makeRequest("?days=7"));
    expect(res.status).toBe(200);
    expect(getHistoryMock).toHaveBeenCalledWith({ days: 7 });
  });

  it("passes undefined days when the query is absent", async () => {
    getHistoryMock.mockReset();
    getHistoryMock.mockResolvedValueOnce({ market: "india", days: [] });

    await getHistory(makeRequest(""));
    expect(getHistoryMock).toHaveBeenCalledWith({ days: undefined });
  });

  it("returns 502 when the history builder throws", async () => {
    getHistoryMock.mockReset();
    getHistoryMock.mockRejectedValueOnce(new Error("db down"));

    const res = await getHistory(makeRequest("?days=14"));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("db down");
  });
});
