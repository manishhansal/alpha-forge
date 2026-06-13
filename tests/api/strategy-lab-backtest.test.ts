import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocks must come before the route import so it picks up the stubbed deps.
const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => authMock(),
}));

const runStrategyMock = vi.fn();
vi.mock("@/features/strategy-lab/run-backtest", () => ({
  runStrategy: (...args: unknown[]) => runStrategyMock(...args),
}));

const saveBacktestMock = vi.fn();
vi.mock("@/features/strategy-lab/storage", () => ({
  saveBacktest: (...args: unknown[]) => saveBacktestMock(...args),
}));

import { POST } from "@/app/api/strategy-lab/backtest/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/strategy-lab/backtest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("API POST /api/strategy-lab/backtest", () => {
  beforeEach(() => {
    authMock.mockReset();
    runStrategyMock.mockReset();
    saveBacktestMock.mockReset();
  });

  it("returns 401 when there is no session", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ prompt: "Buy when RSI < 30", symbol: "BTC", period: "1Y" }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 on a malformed JSON body", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(makeRequest("not json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_JSON");
  });

  it("returns 400 on a body that fails schema validation", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(makeRequest({ prompt: "", symbol: "DOGE", period: "1Y" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 200 with the backtest result on success", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    const fakeResult = { stats: { winRate: 0.5 } };
    runStrategyMock.mockResolvedValue(fakeResult);
    const res = await POST(
      makeRequest({
        prompt: "Buy when RSI drops below 30",
        symbol: "BTC",
        period: "1Y",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(fakeResult);
  });

  it("calls saveBacktest when strategyId is provided", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    runStrategyMock.mockResolvedValue({ stats: {} });
    saveBacktestMock.mockResolvedValue(undefined);

    await POST(
      makeRequest({
        prompt: "Buy when RSI drops below 30",
        symbol: "BTC",
        period: "1Y",
        strategyId: "strategy-123",
      }),
    );
    expect(saveBacktestMock).toHaveBeenCalledTimes(1);
  });

  it("does not call saveBacktest for ad-hoc runs", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    runStrategyMock.mockResolvedValue({ stats: {} });
    await POST(
      makeRequest({
        prompt: "Buy when RSI drops below 30",
        symbol: "BTC",
        period: "1Y",
      }),
    );
    expect(saveBacktestMock).not.toHaveBeenCalled();
  });

  it("returns 502 when runStrategy throws", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    runStrategyMock.mockRejectedValue(new Error("boom"));
    const res = await POST(
      makeRequest({
        prompt: "Buy when RSI drops below 30",
        symbol: "BTC",
        period: "1Y",
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("BACKTEST_FAILED");
  });

  it("does not crash when saveBacktest fails (best-effort)", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    runStrategyMock.mockResolvedValue({ stats: {} });
    saveBacktestMock.mockRejectedValue(new Error("db down"));
    const res = await POST(
      makeRequest({
        prompt: "Buy when RSI drops below 30",
        symbol: "BTC",
        period: "1Y",
        strategyId: "strategy-123",
      }),
    );
    expect(res.status).toBe(200);
  });
});
