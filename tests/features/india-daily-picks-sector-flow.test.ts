/**
 * Pure helpers for the Daily Picks Market Context Header:
 *
 *   - `buildSectorWatch`   — top-2 strong + top-2 weak sectors by intraday %.
 *   - `buildFnoFlowTilt`   — institutional flow proxy derived from SmartAPI's
 *                            OI Buildup category counts (Long Built Up +
 *                            Short Covering = bullish; Short Built Up + Long
 *                            Unwinding = bearish). This is *not* FII ₹Cr —
 *                            SmartAPI does not expose that — but it's the
 *                            closest first-party signal we can surface.
 */

import { describe, expect, it } from "vitest";

import {
  buildFnoFlowTilt,
  buildSectorWatch,
} from "@/features/india/daily-picks/sector-flow";

describe("buildSectorWatch", () => {
  it("returns top-2 strong + top-2 weak by intraday percent change", () => {
    const watch = buildSectorWatch([
      { name: "Bank", changePct: 1.2 },
      { name: "IT", changePct: -0.8 },
      { name: "Auto", changePct: 0.4 },
      { name: "Pharma", changePct: 2.1 },
      { name: "FMCG", changePct: -1.5 },
      { name: "Metal", changePct: 0.1 },
    ]);
    expect(watch).not.toBeNull();
    expect(watch?.strong).toEqual(["Pharma", "Bank"]);
    expect(watch?.weak).toEqual(["FMCG", "IT"]);
  });

  it("ignores null change percentages and still ranks the rest", () => {
    const watch = buildSectorWatch([
      { name: "Bank", changePct: 0.9 },
      { name: "IT", changePct: null },
      { name: "Auto", changePct: -0.3 },
      { name: "Pharma", changePct: 1.5 },
      { name: "FMCG", changePct: null },
    ]);
    expect(watch?.strong).toEqual(["Pharma", "Bank"]);
    expect(watch?.weak[0]).toBe("Auto");
  });

  it("returns null when no sector has a non-null change", () => {
    const watch = buildSectorWatch([
      { name: "Bank", changePct: null },
      { name: "IT", changePct: null },
    ]);
    expect(watch).toBeNull();
  });

  it("returns fewer than 2 entries gracefully when the universe is small", () => {
    const watch = buildSectorWatch([
      { name: "Bank", changePct: 0.5 },
      { name: "IT", changePct: -0.2 },
    ]);
    expect(watch?.strong).toEqual(["Bank"]);
    expect(watch?.weak).toEqual(["IT"]);
  });
});

describe("buildFnoFlowTilt", () => {
  it("labels a net-bullish tilt when long-build-ups dominate", () => {
    const tilt = buildFnoFlowTilt({
      longBuiltUp: 18,
      shortBuiltUp: 4,
      shortCovering: 6,
      longUnwinding: 2,
    });
    // Bullish = (Long Built Up + Short Covering) = 24
    // Bearish = (Short Built Up + Long Unwinding) =  6
    // Net      = 24 - 6 = +18
    expect(tilt).not.toBeNull();
    expect(tilt?.netCr).toBeNull(); // SmartAPI cannot give ₹Cr — stays null.
    expect(tilt?.note).toMatch(/bullish/i);
    expect(tilt?.note).toMatch(/\+18/);
  });

  it("labels a net-bearish tilt when short-build-ups dominate", () => {
    const tilt = buildFnoFlowTilt({
      longBuiltUp: 3,
      shortBuiltUp: 14,
      shortCovering: 1,
      longUnwinding: 8,
    });
    // Bullish = 3 + 1 = 4
    // Bearish = 14 + 8 = 22
    // Net      = 4 - 22 = -18
    expect(tilt?.note).toMatch(/bearish/i);
    expect(tilt?.note).toMatch(/-18/);
  });

  it("returns a neutral tilt when bullish ≈ bearish", () => {
    const tilt = buildFnoFlowTilt({
      longBuiltUp: 5,
      shortBuiltUp: 5,
      shortCovering: 3,
      longUnwinding: 3,
    });
    expect(tilt?.note).toMatch(/neutral|balanced/i);
  });

  it("returns null when every category is empty (Angel unconfigured)", () => {
    expect(
      buildFnoFlowTilt({
        longBuiltUp: 0,
        shortBuiltUp: 0,
        shortCovering: 0,
        longUnwinding: 0,
      }),
    ).toBeNull();
  });
});
