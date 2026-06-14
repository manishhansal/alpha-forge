import { describe, expect, it } from "vitest";

import {
  backtestIndiaPriceStrategy,
  summariseTrades,
  summaryToScoreInput,
} from "@/features/india/scalping/backtest-core";
import { momentumModule } from "@/features/india/scalping/strategies/price-modules";
import type { Candle } from "@/types/india";

describe("india/scalping/backtest-core — summariseTrades", () => {
  it("computes win rate, profit factor, expectancy and drawdown", () => {
    const s = summariseTrades([
      { pnlPct: 2, reason: "TARGET" },
      { pnlPct: -1, reason: "STOP" },
      { pnlPct: 2, reason: "TARGET" },
      { pnlPct: -1, reason: "STOP" },
    ]);
    expect(s.totalTrades).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBeCloseTo(0.5, 5);
    expect(s.profitFactor).toBeCloseTo(2, 5); // 4 / 2
    expect(s.avgPnlPct).toBeCloseTo(0.5, 5);
    expect(s.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(s.sharpe)).toBe(true);
  });

  it("counts EOD/EXPIRED trades as expired and reports infinite PF with no losers", () => {
    const s = summariseTrades([
      { pnlPct: 1, reason: "TARGET" },
      { pnlPct: 0.5, reason: "EOD" },
    ]);
    expect(s.expired).toBe(1);
    expect(s.profitFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns an all-zero summary for an empty trade list", () => {
    const s = summariseTrades([]);
    expect(s.totalTrades).toBe(0);
    expect(s.winRate).toBe(0);
  });
});

describe("india/scalping/backtest-core — summaryToScoreInput", () => {
  it("maps a summary into a risk-aware score input tagged 'backtest'", () => {
    const s = summariseTrades([
      { pnlPct: 2, reason: "TARGET" },
      { pnlPct: -1, reason: "STOP" },
    ]);
    const input = summaryToScoreInput("MOMENTUM", s, "backtest");
    expect(input.strategyId).toBe("MOMENTUM");
    expect(input.source).toBe("backtest");
    expect(typeof input.maxDrawdownPct).toBe("number");
    expect(typeof input.sharpe).toBe("number");
  });
});

describe("india/scalping/backtest-core — backtestIndiaPriceStrategy", () => {
  function flat(n: number, close = 100, volume = 100_000): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
      time: i * 86_400,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume,
    }));
  }

  it("opens a momentum trade on the trigger bar and resolves it forward", () => {
    const candles = flat(25, 100);
    // Strong +4% momentum bar triggers a LONG at index 20.
    candles[20] = { time: 20 * 86_400, open: 100, high: 104, low: 100, close: 104, volume: 120_000 };
    // Next bar tags the ATR target.
    candles[21] = { time: 21 * 86_400, open: 104, high: 112, low: 104, close: 111, volume: 130_000 };

    const trades = backtestIndiaPriceStrategy({ candles, mod: momentumModule });
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0].side).toBe("LONG");
    expect(trades[0].reason).toBe("TARGET");
    expect(trades[0].pnlPct).toBeGreaterThan(0);
  });

  it("produces no trades when there's never a trigger", () => {
    expect(backtestIndiaPriceStrategy({ candles: flat(25, 100), mod: momentumModule })).toEqual([]);
  });
});
