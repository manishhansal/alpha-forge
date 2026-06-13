import { describe, expect, it } from "vitest";

import { parseStrategy } from "@/features/strategy-lab/parser";

describe("features/strategy-lab/parser", () => {
  describe("empty / invalid prompts", () => {
    it("returns an empty parsed shape for empty input", () => {
      const out = parseStrategy("");
      expect(out.warnings).toContain("Empty strategy.");
      expect(out.entry.conditions).toHaveLength(0);
      expect(out.exit).toBeNull();
    });

    it("warns when no entry condition can be parsed", () => {
      const out = parseStrategy("hello world this is not a strategy");
      expect(out.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("LONG entries", () => {
    it("parses 'Buy when RSI drops below 30' as RSI(14) < 30", () => {
      const p = parseStrategy("Buy when RSI drops below 30");
      expect(p.side).toBe("LONG");
      expect(p.entry.conditions).toHaveLength(1);
      const cond = p.entry.conditions[0];
      expect(cond.left).toEqual({ kind: "INDICATOR", ref: { kind: "RSI", period: 14 } });
      expect(cond.comparator).toBe("<");
      expect(cond.right).toEqual({ kind: "NUMBER", value: 30 });
    });

    it("parses inline entry+exit with risk parameters", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30 and sell when RSI crosses above 70. Stop loss 2%, take profit 5%.",
      );
      expect(p.side).toBe("LONG");
      expect(p.entry.conditions).toHaveLength(1);
      expect(p.exit).not.toBeNull();
      expect(p.exit!.conditions).toHaveLength(1);
      expect(p.exit!.conditions[0].comparator).toBe("CROSS_ABOVE");
      expect(p.risk.stopLossPct).toBeCloseTo(0.02);
      expect(p.risk.takeProfitPct).toBeCloseTo(0.05);
    });

    it("recognises EMA crossovers", () => {
      const p = parseStrategy("Long when EMA(20) crosses above EMA(50).");
      expect(p.side).toBe("LONG");
      const cond = p.entry.conditions[0];
      expect(cond.comparator).toBe("CROSS_ABOVE");
      expect(cond.left).toEqual({
        kind: "INDICATOR",
        ref: { kind: "EMA", period: 20 },
      });
      expect(cond.right).toEqual({
        kind: "INDICATOR",
        ref: { kind: "EMA", period: 50 },
      });
    });

    it("handles ATR-based risk", () => {
      const p = parseStrategy(
        "Long when EMA(9) crosses above EMA(21). Stop 1.5x atr, target 3x atr.",
      );
      expect(p.risk.stopAtrMult).toBeCloseTo(1.5);
      expect(p.risk.targetAtrMult).toBeCloseTo(3);
    });

    it("handles N-bar percent change", () => {
      const p = parseStrategy(
        "Buy when price drops 5% in 4 hours. Stop 2%, take profit 5%.",
        { intervalMinutes: 60 },
      );
      const cond = p.entry.conditions[0];
      expect(cond.left).toEqual({
        kind: "INDICATOR",
        ref: { kind: "PCT_CHANGE", lookback: 4 },
      });
      // ≤ -5%
      expect(cond.comparator).toBe("<=");
      if (cond.right.kind === "NUMBER") expect(cond.right.value).toBeCloseTo(-0.05);
    });
  });

  describe("SHORT entries", () => {
    it("parses 'Short when MACD histogram turns negative'", () => {
      const p = parseStrategy(
        "Short when MACD histogram turns negative and price drops 3% in 1 hour. Stop 1.5x ATR, target 3x ATR.",
        { intervalMinutes: 60 },
      );
      expect(p.side).toBe("SHORT");
      expect(p.entry.conditions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("logic operators", () => {
    it("combines conditions with AND when 'and' is present", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30 and EMA(20) crosses above EMA(50).",
      );
      expect(p.entry.logic).toBe("AND");
      expect(p.entry.conditions.length).toBeGreaterThanOrEqual(2);
    });

    it("falls back to OR when 'or' is present at the top level", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30 or RSI crosses above 70.",
      );
      expect(p.entry.logic).toBe("OR");
    });
  });

  describe("notional extraction", () => {
    it("defaults to $1000", () => {
      const p = parseStrategy("Buy when RSI drops below 30. Stop 2%.");
      expect(p.notional).toBe(1000);
    });

    it("parses 'risk $5000 per trade' as 5000", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30. Stop 2%. risk $5000 per trade.",
      );
      expect(p.notional).toBe(5000);
    });

    it("parses bare integer notionals", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30. Stop 2%. risk $5000 per trade.",
      );
      expect(p.notional).toBe(5_000);
    });

    it("parses decimal notionals", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30. Stop 2%. notional $1500.",
      );
      expect(p.notional).toBeCloseTo(1_500);
    });
  });

  describe("summary", () => {
    it("publishes a non-empty summary array", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30 and sell when RSI crosses above 70. Stop 2%, take profit 5%.",
      );
      expect(p.summary.length).toBeGreaterThan(0);
      expect(p.summary[0]).toMatch(/Open/);
    });

    it("reports both stop and target in the summary when both are set", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30. Stop loss 2%, take profit 5%.",
      );
      const joined = p.summary.join("\n").toLowerCase();
      expect(joined).toContain("stop loss");
      expect(joined).toContain("take profit");
    });
  });

  describe("warnings", () => {
    it("warns when both ATR and percentage stops are specified", () => {
      const p = parseStrategy(
        "Buy when RSI drops below 30. Stop 2%, stop 1.5x atr, take profit 5%.",
      );
      expect(p.warnings.some((w) => /atr|%/i.test(w))).toBe(true);
    });
  });
});
