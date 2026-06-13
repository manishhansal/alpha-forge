import { describe, expect, it } from "vitest";

import {
  PERIOD_DURATION_MS,
  PERIOD_FROM_DB,
  PERIOD_INTERVAL,
  PERIOD_LABEL,
  PERIOD_TO_DB,
  STRATEGY_PERIODS,
} from "@/features/strategy-lab/types";

describe("features/strategy-lab/types", () => {
  it("STRATEGY_PERIODS lists all five periods in canonical order", () => {
    expect(STRATEGY_PERIODS).toEqual(["1W", "1M", "6M", "1Y", "5Y"]);
  });

  it("every period has a human-friendly label", () => {
    for (const p of STRATEGY_PERIODS) {
      expect(PERIOD_LABEL[p]).toBeTypeOf("string");
      expect(PERIOD_LABEL[p].length).toBeGreaterThan(0);
    }
  });

  it("PERIOD_TO_DB and PERIOD_FROM_DB are inverses", () => {
    for (const p of STRATEGY_PERIODS) {
      expect(PERIOD_FROM_DB[PERIOD_TO_DB[p]]).toBe(p);
    }
  });

  it("PERIOD_DURATION_MS is monotonic across the canonical order", () => {
    let last = 0;
    for (const p of STRATEGY_PERIODS) {
      expect(PERIOD_DURATION_MS[p]).toBeGreaterThan(last);
      last = PERIOD_DURATION_MS[p];
    }
  });

  it("PERIOD_INTERVAL keeps total candle count under ~5000", () => {
    for (const p of STRATEGY_PERIODS) {
      const interval = PERIOD_INTERVAL[p];
      const intervalMs =
        interval === "15m"
          ? 15 * 60 * 1000
          : interval === "1h"
            ? 60 * 60 * 1000
            : interval === "4h"
              ? 4 * 60 * 60 * 1000
              : 24 * 60 * 60 * 1000;
      const candles = PERIOD_DURATION_MS[p] / intervalMs;
      expect(candles).toBeLessThan(5_000);
    }
  });
});
