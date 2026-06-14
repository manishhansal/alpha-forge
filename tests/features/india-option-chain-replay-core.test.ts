import { describe, expect, it } from "vitest";

import {
  reconstructOcSignal,
  replayOptionChainStrategy,
  type ReplaySnapshot,
} from "@/features/india/scalping/option-chain-replay-core";
import type { OptionChainAnalytics } from "@/types/india/options";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function analytics(over: Partial<OptionChainAnalytics> = {}): OptionChainAnalytics {
  return {
    pcrOi: 1,
    pcrVolume: 1,
    maxCeOiStrike: null,
    maxPeOiStrike: null,
    totalCeOi: 0,
    totalPeOi: 0,
    totalCeOiChange: 0,
    totalPeOiChange: 0,
    atmIv: 16,
    maxPain: null,
    ...over,
  };
}

/** Build a snapshot at a given IST hour/minute on 2026-06-15 (a Monday). */
function snap(
  spot: number,
  istHour: number,
  istMin: number,
  over: Partial<OptionChainAnalytics> = {},
  changePct: number | null = 0,
  dayOffset = 0,
): ReplaySnapshot {
  const base = Date.UTC(2026, 5, 15 + dayOffset, 0, 0, 0);
  const ms = base - IST_OFFSET_MS + (istHour * 60 + istMin) * 60_000;
  return {
    underlying: "NIFTY",
    spot,
    changePct,
    analytics: analytics(over),
    capturedAtMs: ms,
  };
}

describe("reconstructOcSignal", () => {
  it("PCR_EXTREME goes LONG above 1.3, SHORT below 0.7, flat in between", () => {
    const long = reconstructOcSignal("PCR_EXTREME", snap(100, 10, 0, { pcrOi: 1.5 }));
    const short = reconstructOcSignal("PCR_EXTREME", snap(100, 10, 0, { pcrOi: 0.5 }));
    const flat = reconstructOcSignal("PCR_EXTREME", snap(100, 10, 0, { pcrOi: 1.0 }));
    expect(long?.direction).toBe("LONG");
    expect(short?.direction).toBe("SHORT");
    expect(flat).toBeNull();
  });

  it("IV_SPIKE goes LONG when elevated, SHORT when compressed, flat mid-band", () => {
    expect(reconstructOcSignal("IV_SPIKE", snap(100, 10, 0, { atmIv: 22 }))?.direction).toBe("LONG");
    expect(reconstructOcSignal("IV_SPIKE", snap(100, 10, 0, { atmIv: 12 }))?.direction).toBe("SHORT");
    expect(reconstructOcSignal("IV_SPIKE", snap(100, 10, 0, { atmIv: 16 }))).toBeNull();
  });

  it("OI_BUILDUP reads price×OI quadrant for direction", () => {
    // price up + OI up = LONG_BUILDUP → LONG
    const lb = reconstructOcSignal(
      "OI_BUILDUP",
      snap(100, 10, 0, { totalCeOiChange: 10, totalPeOiChange: 40 }, 1.2),
    );
    // price down + OI up = SHORT_BUILDUP → SHORT
    const sb = reconstructOcSignal(
      "OI_BUILDUP",
      snap(100, 10, 0, { totalCeOiChange: 40, totalPeOiChange: 10 }, -1.2),
    );
    expect(lb?.direction).toBe("LONG");
    expect(sb?.direction).toBe("SHORT");
  });

  it("OI_BUILDUP is flat when there is no net OI change", () => {
    expect(
      reconstructOcSignal("OI_BUILDUP", snap(100, 10, 0, { totalCeOiChange: 0, totalPeOiChange: 0 }, 1)),
    ).toBeNull();
  });

  it("delegates LIQUIDITY_EDGE / MAX_PAIN_GRAVITY to positioning-core", () => {
    // Strong bullish confluence → ILE LONG.
    const ile = reconstructOcSignal(
      "LIQUIDITY_EDGE",
      snap(100, 10, 0, {
        pcrOi: 1.4,
        maxPain: 110,
        maxPeOiStrike: 100,
        totalPeOiChange: 50,
        totalCeOiChange: 10,
      }, 1.5),
    );
    expect(ile?.direction).toBe("LONG");

    // Spot well above max pain → IMPG fades SHORT toward pain.
    const impg = reconstructOcSignal(
      "MAX_PAIN_GRAVITY",
      snap(100, 10, 0, { maxPain: 98 }),
    );
    expect(impg?.direction).toBe("SHORT");
  });
});

describe("replayOptionChainStrategy", () => {
  it("opens on an extreme PCR and books a WIN when spot reaches target", () => {
    const series: ReplaySnapshot[] = [
      snap(100, 10, 0, { pcrOi: 1.5 }), // open LONG: target 101, stop 99.5
      snap(100.5, 10, 5, { pcrOi: 1.5 }), // still open
      snap(101.2, 10, 10, { pcrOi: 1.5 }), // >= target → WIN
    ];
    const trades = replayOptionChainStrategy(series, "PCR_EXTREME");
    expect(trades).toHaveLength(1);
    expect(trades[0].reason).toBe("TARGET");
    expect(trades[0].side).toBe("LONG");
    expect(trades[0].pnlPct).toBeGreaterThan(0);
  });

  it("books a LOSS when spot hits the stop first", () => {
    const series: ReplaySnapshot[] = [
      snap(100, 10, 0, { pcrOi: 1.5 }),
      snap(99.4, 10, 5, { pcrOi: 1.5 }), // <= stop 99.5 → LOSS
    ];
    const trades = replayOptionChainStrategy(series, "PCR_EXTREME");
    expect(trades).toHaveLength(1);
    expect(trades[0].reason).toBe("STOP");
    expect(trades[0].pnlPct).toBeLessThan(0);
  });

  it("force-closes an open position at the IST day boundary (EXPIRED)", () => {
    const series: ReplaySnapshot[] = [
      snap(100, 15, 0, { pcrOi: 1.5 }), // open near close
      snap(100.2, 9, 30, { pcrOi: 1.5 }, 0, 1), // next day → expire at prior spot
    ];
    const trades = replayOptionChainStrategy(series, "PCR_EXTREME");
    expect(trades).toHaveLength(1);
    expect(trades[0].reason).toBe("EXPIRED");
  });

  it("returns no trades when nothing fires", () => {
    const series: ReplaySnapshot[] = [
      snap(100, 10, 0, { pcrOi: 1.0 }),
      snap(100.5, 10, 5, { pcrOi: 1.05 }),
    ];
    expect(replayOptionChainStrategy(series, "PCR_EXTREME")).toHaveLength(0);
  });
});
