import { describe, expect, it, vi } from "vitest";

const getStrategyBacktestSuiteMock = vi.fn();

vi.mock("@/features/scalping/run-all-backtests", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/scalping/run-all-backtests")
  >("@/features/scalping/run-all-backtests");
  return {
    ...actual,
    getStrategyBacktestSuite: (...args: unknown[]) =>
      getStrategyBacktestSuiteMock(...args),
  };
});

import { GET } from "@/app/api/scalper/backtest/route";

function fakeSuite() {
  return {
    generatedAt: new Date().toISOString(),
    interval: "4h",
    periodLabel: "5Y",
    periodMs: 5 * 365 * 24 * 3_600_000,
    periodYears: 5,
    startEquity: 10_000,
    notional: 1_000,
    candleSource: "binance",
    candleMeta: { fetchedBars: 1_000 },
    reports: [
      {
        strategyId: "ut-bot",
        score: 0.42,
        aggregate: { winRate: 0.6, trades: 100, pnlPct: 0.18 },
        perSymbol: [
          {
            symbol: "BTCUSDT",
            stats: { winRate: 0.6, trades: 50, pnlPct: 0.2 },
            equityCurve: [10_000, 10_500, 11_000],
            trades: [{ entry: 1, exit: 2, pnl: 50 }, { entry: 3, exit: 4, pnl: -10 }],
          },
        ],
      },
    ],
  };
}

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/scalper/backtest${qs}`);
}

describe("api/scalper/backtest", () => {
  it("returns the compact summary shape by default (no per-trade list)", async () => {
    getStrategyBacktestSuiteMock.mockReset();
    getStrategyBacktestSuiteMock.mockResolvedValueOnce(fakeSuite());

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/private,\s*max-age=\d+/);
    const body = (await res.json()) as {
      reports: Array<{ strategyId: string; perSymbol: Array<{ tradeCount: number; trades?: unknown }> }>;
    };
    expect(body.reports[0].strategyId).toBe("ut-bot");
    expect(body.reports[0].perSymbol[0].tradeCount).toBe(2);
    // Trades themselves are stripped from the summary view.
    expect(body.reports[0].perSymbol[0]).not.toHaveProperty("trades");
  });

  it("returns the full suite (with trades) when detail=full", async () => {
    getStrategyBacktestSuiteMock.mockReset();
    getStrategyBacktestSuiteMock.mockResolvedValueOnce(fakeSuite());

    const res = await GET(makeRequest("?detail=full"));
    const body = (await res.json()) as {
      reports: Array<{ perSymbol: Array<{ trades: unknown[] }> }>;
    };
    expect(body.reports[0].perSymbol[0].trades).toHaveLength(2);
  });

  it("falls back to the default interval for an unsupported `interval`", async () => {
    getStrategyBacktestSuiteMock.mockReset();
    getStrategyBacktestSuiteMock.mockResolvedValueOnce(fakeSuite());

    await GET(makeRequest("?interval=quasar"));
    const passed = getStrategyBacktestSuiteMock.mock.calls[0][0] as {
      interval: string;
    };
    expect(["1m", "5m", "10m", "15m", "1h", "4h", "1d"]).toContain(passed.interval);
  });

  it("forwards force=1 to the suite runner", async () => {
    getStrategyBacktestSuiteMock.mockReset();
    getStrategyBacktestSuiteMock.mockResolvedValueOnce(fakeSuite());

    await GET(makeRequest("?force=1"));
    expect(getStrategyBacktestSuiteMock.mock.calls[0][0]).toMatchObject({ force: true });
  });

  it("returns 502 with BACKTEST_FAILED when the suite throws", async () => {
    getStrategyBacktestSuiteMock.mockReset();
    getStrategyBacktestSuiteMock.mockRejectedValueOnce(new Error("kline fetch failed"));

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: boolean;
      code: string;
      message: string;
      meta: { interval: string };
    };
    expect(body.code).toBe("BACKTEST_FAILED");
    expect(body.message).toBe("kline fetch failed");
    expect(body.meta.interval).toBeTypeOf("string");
  });
});
