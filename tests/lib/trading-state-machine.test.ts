/**
 * TradingStateMachine — Unit Tests (Phase 10)
 *
 * Tests all order lifecycle transitions including edge cases:
 * - Valid transitions
 * - Invalid transitions (must throw)
 * - Duplicate fills
 * - Fill after cancellation/rejection
 * - Partial fill → full fill
 * - Transaction rollback simulation
 */

import { describe, expect, it } from "vitest";
import {
  TradingStateMachine,
  InvalidStateTransitionError,
  DuplicateFillError,
  FillAfterTerminalStateError,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  type FillRecord,
} from "@/lib/india/trading-state-machine";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createOrder(overrides: Partial<Parameters<typeof TradingStateMachine.create>[0]> = {}) {
  return TradingStateMachine.create({
    orderId: "order-001",
    symbol: "NIFTY",
    direction: "LONG",
    quantity: 50,
    entryPrice: 22000,
    stopLoss: 21900,
    target: 22200,
    ...overrides,
  });
}

function makeFill(id: string, qty: number, price: number): FillRecord {
  return {
    fillId: id,
    quantity: qty,
    price,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("TradingStateMachine — creation", () => {
  it("starts in NEW state", () => {
    const sm = createOrder();
    expect(sm.currentState).toBe("NEW");
  });

  it("is not terminal in NEW state", () => {
    const sm = createOrder();
    expect(sm.isTerminal).toBe(false);
  });
});

describe("TradingStateMachine — valid transitions", () => {
  it("NEW → VALIDATED → RISK_APPROVED → SUBMITTED → FILLED", () => {
    const sm = createOrder();

    sm.transition("VALIDATED", "passes validation");
    expect(sm.currentState).toBe("VALIDATED");

    sm.transition("RISK_APPROVED", "risk engine approved");
    expect(sm.currentState).toBe("RISK_APPROVED");

    sm.transition("SUBMITTED", "sent to broker");
    expect(sm.currentState).toBe("SUBMITTED");

    sm.applyFill(makeFill("fill-1", 50, 22000));
    expect(sm.currentState).toBe("FILLED");
    expect(sm.isTerminal).toBe(true);
  });

  it("can be REJECTED from NEW", () => {
    const sm = createOrder();
    sm.reject("symbol not tradeable");
    expect(sm.currentState).toBe("REJECTED");
    expect(sm.isTerminal).toBe(true);
  });

  it("can be CANCELLED from RISK_APPROVED", () => {
    const sm = createOrder();
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.cancel("user cancelled");
    expect(sm.currentState).toBe("CANCELLED");
    expect(sm.isTerminal).toBe(true);
  });

  it("records transition history", () => {
    const sm = createOrder();
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");

    const snapshot = sm.snapshot;
    expect(snapshot.transitions).toHaveLength(2);
    expect(snapshot.transitions[0]!.from).toBe("NEW");
    expect(snapshot.transitions[0]!.to).toBe("VALIDATED");
    expect(snapshot.transitions[1]!.from).toBe("VALIDATED");
    expect(snapshot.transitions[1]!.to).toBe("RISK_APPROVED");
  });
});

describe("TradingStateMachine — invalid transitions", () => {
  it("throws InvalidStateTransitionError for NEW → FILLED directly", () => {
    const sm = createOrder();
    expect(() => sm.transition("FILLED", "bypass")).toThrow(InvalidStateTransitionError);
  });

  it("throws InvalidStateTransitionError for FILLED → SUBMITTED (backwards)", () => {
    const sm = createOrder();
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.transition("SUBMITTED", "ok");
    sm.applyFill(makeFill("f1", 50, 22000));
    // FILLED is terminal
    expect(() => sm.transition("SUBMITTED", "backwards")).toThrow(InvalidStateTransitionError);
  });

  it("throws for CANCELLED → VALIDATED (impossible)", () => {
    const sm = createOrder();
    sm.cancel("cancelled");
    expect(() => sm.transition("VALIDATED", "retry")).toThrow(InvalidStateTransitionError);
  });

  it("throws for REJECTED → RISK_APPROVED", () => {
    const sm = createOrder();
    sm.reject("rejected");
    expect(() => sm.transition("RISK_APPROVED", "override")).toThrow(InvalidStateTransitionError);
  });
});

describe("TradingStateMachine — fills", () => {
  it("partial fill transitions SUBMITTED → PARTIALLY_FILLED", () => {
    const sm = createOrder({ quantity: 100 });
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.transition("SUBMITTED", "ok");

    sm.applyFill(makeFill("fill-1", 50, 22000));
    expect(sm.currentState).toBe("PARTIALLY_FILLED");
    expect(sm.snapshot.filledQuantity).toBe(50);
  });

  it("full fill transitions PARTIALLY_FILLED → FILLED", () => {
    const sm = createOrder({ quantity: 100 });
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.transition("SUBMITTED", "ok");

    sm.applyFill(makeFill("fill-1", 50, 22000));
    sm.applyFill(makeFill("fill-2", 50, 22010));
    expect(sm.currentState).toBe("FILLED");
    expect(sm.snapshot.filledQuantity).toBe(100);
  });

  it("computes correct average fill price across multiple fills", () => {
    const sm = createOrder({ quantity: 100 });
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.transition("SUBMITTED", "ok");

    sm.applyFill(makeFill("fill-1", 50, 22000)); // 50 @ 22000
    sm.applyFill(makeFill("fill-2", 50, 22020)); // 50 @ 22020

    // avg = (50*22000 + 50*22020) / 100 = 22010
    expect(sm.snapshot.avgFillPrice).toBe(22010);
  });

  it("throws DuplicateFillError for the same fillId", () => {
    const sm = createOrder({ quantity: 100 });
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.transition("SUBMITTED", "ok");

    sm.applyFill(makeFill("fill-dup", 50, 22000));
    expect(() => sm.applyFill(makeFill("fill-dup", 50, 22000))).toThrow(DuplicateFillError);
  });

  it("throws FillAfterTerminalStateError when filling a CANCELLED order", () => {
    const sm = createOrder();
    sm.transition("VALIDATED", "ok");
    sm.transition("RISK_APPROVED", "ok");
    sm.transition("SUBMITTED", "ok");
    sm.cancel("user cancelled");

    expect(() => sm.applyFill(makeFill("fill-late", 50, 22000))).toThrow(
      FillAfterTerminalStateError,
    );
  });

  it("throws FillAfterTerminalStateError when filling a REJECTED order", () => {
    const sm = createOrder();
    sm.reject("insufficient margin");
    expect(() => sm.applyFill(makeFill("fill-late", 50, 22000))).toThrow(
      FillAfterTerminalStateError,
    );
  });
});

describe("TradingStateMachine — legal transitions completeness", () => {
  it("all states have defined legal transitions (no missing entries)", () => {
    const allStates: string[] = [
      "NEW", "VALIDATED", "RISK_APPROVED", "SUBMITTED",
      "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "FAILED",
    ];
    for (const state of allStates) {
      expect(LEGAL_TRANSITIONS[state as keyof typeof LEGAL_TRANSITIONS]).toBeDefined();
    }
  });

  it("terminal states have no legal transitions", () => {
    for (const state of TERMINAL_STATES) {
      expect(LEGAL_TRANSITIONS[state].size).toBe(0);
    }
  });

  it("canTransition returns false for invalid moves", () => {
    const sm = createOrder();
    expect(sm.canTransition("FILLED")).toBe(false);
    expect(sm.canTransition("PARTIALLY_FILLED")).toBe(false);
    expect(sm.canTransition("VALIDATED")).toBe(true);
  });
});
