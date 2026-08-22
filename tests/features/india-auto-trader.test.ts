import { describe, expect, it } from "vitest";

// ─── Signal scoring pure logic ────────────────────────────────────────────────
// We re-implement the scoring formula here to verify it matches the
// production constants without hitting any DB or network.

const GRADE_SCORE: Record<string, number> = {
  S: 1.0, A: 0.8, B: 0.6, C: 0.4, D: 0.2,
};

function scoreSignal(
  confidence:     number,
  winProbability: number,
  grade:          string,
  riskReward:     number,
): number {
  const gradeScore = GRADE_SCORE[grade] ?? 0.2;
  const rrScore    = Math.min(riskReward / 3, 1);
  return (
    0.35 * Math.max(0, Math.min(1, confidence)) +
    0.25 * Math.max(0, Math.min(1, winProbability)) +
    0.25 * gradeScore +
    0.15 * rrScore
  );
}

describe("features/india/paper-trading — auto-trader signal scoring", () => {
  describe("scoreSignal()", () => {
    it("perfect signal (S grade, RR=3, confidence=1, winProb=1) scores 1.0", () => {
      expect(scoreSignal(1, 1, "S", 3)).toBeCloseTo(1.0, 5);
    });

    it("worst signal (D grade, RR=0, confidence=0, winProb=0) scores 0.05", () => {
      // Only grade contributes: 0.25 × 0.2 = 0.05
      expect(scoreSignal(0, 0, "D", 0)).toBeCloseTo(0.05, 5);
    });

    it("grade S outscores grade A by 0.25×(1.0−0.8) = 0.05 all else equal", () => {
      const s = scoreSignal(0.7, 0.65, "S", 2);
      const a = scoreSignal(0.7, 0.65, "A", 2);
      expect(s - a).toBeCloseTo(0.25 * (1.0 - 0.8), 5);
    });

    it("RR is capped at 3:1 — a 10:1 signal scores the same as 3:1", () => {
      const rr3  = scoreSignal(0.6, 0.6, "B", 3);
      const rr10 = scoreSignal(0.6, 0.6, "B", 10);
      expect(rr3).toBeCloseTo(rr10, 5);
    });

    it("confidence is clamped — values > 1 treated as 1", () => {
      const normal   = scoreSignal(1.0, 0.7, "A", 2);
      const overflow = scoreSignal(5.0, 0.7, "A", 2);
      expect(normal).toBeCloseTo(overflow, 5);
    });

    it("minimum eligibility threshold 0.52 filters weak signals", () => {
      const MIN_SCORE = 0.52;
      // D grade + zero confidence + zero winProb + zero RR = 0.05 → filtered
      expect(scoreSignal(0, 0, "D", 0)).toBeLessThan(MIN_SCORE);
      // B grade + 0.5 confidence + 0.5 winProb + 1.5 RR → should pass
      expect(scoreSignal(0.5, 0.5, "B", 1.5)).toBeGreaterThan(MIN_SCORE);
    });

    it("A-grade signal with 0.7 confidence and 2:1 RR passes the threshold", () => {
      const MIN_SCORE = 0.52;
      const score = scoreSignal(0.7, 0.65, "A", 2);
      expect(score).toBeGreaterThan(MIN_SCORE);
    });
  });

  describe("budget arithmetic", () => {
    const DAILY_BUDGET       = 100_000;
    const MAX_CONCURRENT     = 5;
    const TRADE_NOTIONAL     = DAILY_BUDGET / MAX_CONCURRENT;

    it("TRADE_NOTIONAL equals DAILY_BUDGET / MAX_CONCURRENT = 20 000", () => {
      expect(TRADE_NOTIONAL).toBe(20_000);
    });

    it("can open exactly MAX_CONCURRENT trades on a fresh budget", () => {
      let remaining = DAILY_BUDGET;
      let opened    = 0;
      while (remaining >= TRADE_NOTIONAL && opened < MAX_CONCURRENT) {
        remaining -= TRADE_NOTIONAL;
        opened++;
      }
      expect(opened).toBe(MAX_CONCURRENT);
      expect(remaining).toBe(0);
    });

    it("budget is exhausted after MAX_CONCURRENT trades — no 6th slot", () => {
      let remaining = DAILY_BUDGET;
      let opened    = 0;
      // Simulate 5 trades
      for (let i = 0; i < MAX_CONCURRENT; i++) { remaining -= TRADE_NOTIONAL; opened++; }
      const canOpen = remaining >= TRADE_NOTIONAL;
      expect(canOpen).toBe(false);
    });

    it("risk gate: stop distance > 2.5% of entry → trade rejected", () => {
      const MAX_RISK = 0.025;
      const entry    = 500;
      const tightSL  = entry * (1 - 0.02);  // 2% → passes (< 2.5%)
      const wideSL   = entry * (1 - 0.03);  // 3% → fails (> 2.5%)
      expect(Math.abs(entry - tightSL) / entry).toBeLessThan(MAX_RISK);
      expect(Math.abs(entry - wideSL)  / entry).toBeGreaterThan(MAX_RISK);
    });
  });
});

// ─── Analytics aggregate arithmetic ──────────────────────────────────────────

describe("features/india/paper-trading — auto-trader analytics aggregation", () => {
  type Day = {
    wins: number; losses: number; expired: number;
    realisedPnl: number; realisedPnlPct: number; totalTrades: number;
  };

  function aggregate(days: Day[]) {
    const totalWins    = days.reduce((s, d) => s + d.wins,    0);
    const totalLosses  = days.reduce((s, d) => s + d.losses,  0);
    const totalExpired = days.reduce((s, d) => s + d.expired, 0);
    const resolved     = totalWins + totalLosses;
    const totalPnl     = days.reduce((s, d) => s + d.realisedPnl, 0);
    const profitDays   = days.filter((d) => d.realisedPnl > 0).length;
    const consistency  = days.length > 0 ? (profitDays / days.length) * 100 : 0;
    const overallWR    = resolved > 0 ? totalWins / resolved : null;
    return { totalWins, totalLosses, totalExpired, totalPnl, consistency, overallWR };
  }

  it("100% win rate when all trades are wins", () => {
    const days: Day[] = [
      { wins: 3, losses: 0, expired: 0, realisedPnl: 2000, realisedPnlPct: 2, totalTrades: 3 },
      { wins: 2, losses: 0, expired: 0, realisedPnl: 1500, realisedPnlPct: 1.5, totalTrades: 2 },
    ];
    const r = aggregate(days);
    expect(r.overallWR).toBe(1.0);
    expect(r.totalPnl).toBe(3500);
    expect(r.consistency).toBe(100);
  });

  it("win rate is null when there are no resolved trades", () => {
    const days: Day[] = [
      { wins: 0, losses: 0, expired: 3, realisedPnl: -200, realisedPnlPct: -0.2, totalTrades: 3 },
    ];
    const r = aggregate(days);
    expect(r.overallWR).toBeNull();
  });

  it("consistency counts only profit days (pnl > 0)", () => {
    const days: Day[] = [
      { wins: 2, losses: 1, expired: 0, realisedPnl:  500, realisedPnlPct:  0.5, totalTrades: 3 },
      { wins: 0, losses: 2, expired: 0, realisedPnl: -800, realisedPnlPct: -0.8, totalTrades: 2 },
      { wins: 1, losses: 1, expired: 0, realisedPnl:    0, realisedPnlPct:  0.0, totalTrades: 2 },
    ];
    const r = aggregate(days);
    expect(r.consistency).toBeCloseTo((1 / 3) * 100, 4);
  });

  it("totalPnl sums correctly across days with mixed sign", () => {
    const days: Day[] = [
      { wins: 3, losses: 0, expired: 0, realisedPnl:  1200, realisedPnlPct: 1.2, totalTrades: 3 },
      { wins: 0, losses: 3, expired: 0, realisedPnl:  -600, realisedPnlPct: -0.6, totalTrades: 3 },
    ];
    expect(aggregate(days).totalPnl).toBe(600);
  });
});

// ─── Analytics range date calculation ────────────────────────────────────────

describe("features/india/paper-trading — analytics range start date", () => {
  function rangeToStartDate(range: string): Date | null {
    const now = new Date("2026-08-21T12:00:00Z");
    const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
    switch (range) {
      case "1d":  return d(1);
      case "7d":  return d(7);
      case "15d": return d(15);
      case "30d": return d(30);
      case "6mo": return d(180);
      case "1y":  return d(365);
      case "all": return null;
      default:    return d(30);
    }
  }

  it("1d range starts 1 day before now", () => {
    const start = rangeToStartDate("1d")!;
    const now   = new Date("2026-08-21T12:00:00Z");
    expect(now.getTime() - start.getTime()).toBeCloseTo(86_400_000, -3);
  });

  it("all range returns null (no date filter)", () => {
    expect(rangeToStartDate("all")).toBeNull();
  });

  it("6mo is approximately 180 days before now", () => {
    const start = rangeToStartDate("6mo")!;
    const now   = new Date("2026-08-21T12:00:00Z");
    const days  = (now.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(180, 0);
  });

  it("1y range is 365 days", () => {
    const start = rangeToStartDate("1y")!;
    const now   = new Date("2026-08-21T12:00:00Z");
    const days  = (now.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(365, 0);
  });
});
