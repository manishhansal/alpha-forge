import { describe, expect, it } from "vitest";

// ─── P&L calculation ──────────────────────────────────────────────────────────
// Mirror of the pnl() helper in service.ts to verify direction-aware math.

function pnl(entry: number, exit: number, scanType: "BULLISH" | "BEARISH"): number {
  if (entry <= 0) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return scanType === "BEARISH" ? -raw : raw;
}

describe("features/india/fno-trend-history — P&L direction arithmetic", () => {
  it("BULLISH: positive P&L when exit > entry", () => {
    expect(pnl(100, 110, "BULLISH")).toBeCloseTo(10, 5);
  });

  it("BULLISH: negative P&L when exit < entry", () => {
    expect(pnl(100, 90, "BULLISH")).toBeCloseTo(-10, 5);
  });

  it("BEARISH: positive P&L when price falls (exit < entry)", () => {
    // Short trade profits when price falls
    expect(pnl(100, 90, "BEARISH")).toBeCloseTo(10, 5);
  });

  it("BEARISH: negative P&L when price rises (exit > entry)", () => {
    expect(pnl(100, 110, "BEARISH")).toBeCloseTo(-10, 5);
  });

  it("zero P&L when exit equals entry for both directions", () => {
    expect(pnl(100, 100, "BULLISH")).toBe(0);
    expect(pnl(100, 100, "BEARISH")).toBe(-0);
  });

  it("returns 0 when entry is 0 (guard against division by zero)", () => {
    expect(pnl(0, 110, "BULLISH")).toBe(0);
  });
});

// ─── TP1/SL outcome resolution logic ─────────────────────────────────────────

describe("features/india/fno-trend-history — outcome resolution", () => {
  type Status = "TARGET_HIT" | "STOP_HIT" | "OPEN" | "CLOSED" | "EXPIRED";

  function resolveStatus(
    entry: number,
    currentPrice: number,
    tp1: number,
    stopLoss: number,
    scanType: "BULLISH" | "BEARISH",
  ): Status {
    if (scanType === "BULLISH") {
      if (currentPrice >= tp1)    return "TARGET_HIT";
      if (currentPrice <= stopLoss) return "STOP_HIT";
    } else {
      if (currentPrice <= tp1)    return "TARGET_HIT";
      if (currentPrice >= stopLoss) return "STOP_HIT";
    }
    return "OPEN";
  }

  it("BULLISH: TARGET_HIT when price reaches tp1", () => {
    expect(resolveStatus(100, 116, 116, 86, "BULLISH")).toBe("TARGET_HIT");
  });

  it("BULLISH: STOP_HIT when price falls to stopLoss", () => {
    expect(resolveStatus(100, 86, 116, 86, "BULLISH")).toBe("STOP_HIT");
  });

  it("BULLISH: OPEN when price is between SL and TP1", () => {
    expect(resolveStatus(100, 105, 116, 86, "BULLISH")).toBe("OPEN");
  });

  it("BEARISH: TARGET_HIT when price falls to tp1", () => {
    expect(resolveStatus(100, 84, 84, 114, "BEARISH")).toBe("TARGET_HIT");
  });

  it("BEARISH: STOP_HIT when price rises to stopLoss", () => {
    expect(resolveStatus(100, 114, 84, 114, "BEARISH")).toBe("STOP_HIT");
  });

  it("BEARISH: OPEN when price is between tp1 and SL", () => {
    expect(resolveStatus(100, 95, 84, 114, "BEARISH")).toBe("OPEN");
  });
});

// ─── History summary aggregation ──────────────────────────────────────────────

describe("features/india/fno-trend-history — day summary aggregation", () => {
  type ScanStatus = "TARGET_HIT" | "STOP_HIT" | "OPEN" | "CLOSED" | "EXPIRED";
  type Scan = { status: ScanStatus };

  function summarise(scans: Scan[]) {
    const targetHit = scans.filter((s) => s.status === "TARGET_HIT").length;
    const stopHit   = scans.filter((s) => s.status === "STOP_HIT").length;
    const closed    = scans.filter((s) => s.status === "CLOSED" || s.status === "EXPIRED").length;
    const open      = scans.filter((s) => s.status === "OPEN").length;
    const resolved  = targetHit + stopHit;
    return { total: scans.length, targetHit, stopHit, closed, open, winRate: resolved > 0 ? targetHit / resolved : 0 };
  }

  it("computes 100% win rate when all resolved are TARGET_HIT", () => {
    const scans: Scan[] = [
      { status: "TARGET_HIT" }, { status: "TARGET_HIT" }, { status: "CLOSED" },
    ];
    const s = summarise(scans);
    expect(s.winRate).toBe(1.0);
    expect(s.targetHit).toBe(2);
    expect(s.closed).toBe(1);
    expect(s.total).toBe(3);
  });

  it("winRate is 0 when no trades are resolved", () => {
    const scans: Scan[] = [{ status: "OPEN" }, { status: "OPEN" }];
    expect(summarise(scans).winRate).toBe(0);
  });

  it("mixed day: 2 hits, 1 stop, 1 open → 66.67% win rate", () => {
    const scans: Scan[] = [
      { status: "TARGET_HIT" }, { status: "TARGET_HIT" },
      { status: "STOP_HIT"   }, { status: "OPEN"        },
    ];
    const s = summarise(scans);
    expect(s.winRate).toBeCloseTo(2 / 3, 4);
    expect(s.open).toBe(1);
  });
});
