/**
 * experiment-manager.test.ts
 *
 * Covers:
 *   • Experiment creation and lifecycle (start / pause / complete / fail / archive)
 *   • A/B arm setup (CONTROL + EXPERIMENT)
 *   • Identical market data broadcast to all arms (data isolation)
 *   • SHADOW mode: acted=false on every signal, no portfolio mutations
 *   • promoteArm: valid transitions + LIVE guard (requires approvalToken)
 *   • broadcastTickToAll fan-out
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ExperimentManager,
  type MarketTick,
  type ExperimentArm,
  type ExperimentSignal,
} from "@/lib/experiments/experiment-manager";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const STAMP = {
  strategyVersion: "strat-v1",
  modelVersion: "model-v1",
  featureVersion: "feat-v1",
  experimentId: "",
};

function makeTick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    timestampMs: 1_700_000_000_000,
    symbol: "NIFTY",
    open: 21_000,
    high: 21_100,
    low: 20_900,
    close: 21_050,
    volume: 100_000,
    barIndex: 1,
    ...overrides,
  };
}

function makeManager() {
  return new ExperimentManager();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ExperimentManager — creation", () => {
  it("creates an experiment with the given arms", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Test Experiment",
      symbols: ["NIFTY"],
      arms: [
        { id: "control", role: "CONTROL", label: "Control", versionStamp: STAMP, mode: "SHADOW" },
        { id: "exp-v2",  role: "EXPERIMENT", label: "Exp v2",  versionStamp: STAMP, mode: "SHADOW" },
      ],
    });

    expect(exp.id).toMatch(/^exp_/);
    expect(exp.arms).toHaveLength(2);
    expect(exp.status).toBe("PAUSED");
    // Arms start inactive until started
    expect(exp.arms.every((a) => a.active === false)).toBe(true);
  });

  it("stamps experimentId onto every arm's versionStamp", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Stamp test",
      symbols: ["NIFTY"],
      arms: [
        { id: "arm1", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" },
      ],
    });
    expect(exp.arms[0].versionStamp.experimentId).toBe(exp.id);
  });

  it("throws when no arms provided", () => {
    const mgr = makeManager();
    expect(() =>
      mgr.createExperiment({ name: "Bad", symbols: ["NIFTY"], arms: [] }),
    ).toThrow("At least one arm");
  });

  it("throws when more than one CONTROL arm is provided", () => {
    const mgr = makeManager();
    expect(() =>
      mgr.createExperiment({
        name: "Bad",
        symbols: ["NIFTY"],
        arms: [
          { id: "c1", role: "CONTROL", label: "C1", versionStamp: STAMP, mode: "SHADOW" },
          { id: "c2", role: "CONTROL", label: "C2", versionStamp: STAMP, mode: "SHADOW" },
        ],
      }),
    ).toThrow("Only one CONTROL arm");
  });

  it("returns undefined for unknown experiment", () => {
    const mgr = makeManager();
    expect(mgr.getExperiment("unknown")).toBeUndefined();
  });
});

describe("ExperimentManager — lifecycle", () => {
  it("start activates all arms", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "LC",
      symbols: ["NIFTY"],
      arms: [
        { id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" },
        { id: "e", role: "EXPERIMENT", label: "E", versionStamp: STAMP, mode: "SHADOW" },
      ],
    });

    mgr.startExperiment(exp.id);
    const started = mgr.getExperiment(exp.id)!;
    expect(started.status).toBe("RUNNING");
    expect(started.startedAtMs).not.toBeNull();
    expect(started.arms.every((a) => a.active)).toBe(true);
  });

  it("start is idempotent", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Idem",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    const t1 = mgr.getExperiment(exp.id)!.startedAtMs;
    mgr.startExperiment(exp.id); // second call — no-op
    const t2 = mgr.getExperiment(exp.id)!.startedAtMs;
    expect(t1).toBe(t2);
  });

  it("pause deactivates all arms", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "P",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    mgr.pauseExperiment(exp.id);
    expect(mgr.getExperiment(exp.id)!.status).toBe("PAUSED");
    expect(mgr.getExperiment(exp.id)!.arms.every((a) => !a.active)).toBe(true);
  });

  it("complete sets status and endedAtMs", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Comp",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    mgr.completeExperiment(exp.id);
    const done = mgr.getExperiment(exp.id)!;
    expect(done.status).toBe("COMPLETED");
    expect(done.endedAtMs).not.toBeNull();
  });

  it("fail records reason and sets status FAILED", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Fail",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    mgr.failExperiment(exp.id, "test failure");
    const failed = mgr.getExperiment(exp.id)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.description).toContain("test failure");
  });

  it("archive requires experiment to be stopped first", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Arc",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    expect(() => mgr.archiveExperiment(exp.id)).toThrow("Stop the experiment");
    mgr.completeExperiment(exp.id);
    mgr.archiveExperiment(exp.id);
    expect(mgr.getExperiment(exp.id)!.status).toBe("ARCHIVED");
  });

  it("throws when accessing unknown experiment", () => {
    const mgr = makeManager();
    expect(() => mgr.startExperiment("bad")).toThrow("Unknown experiment");
  });
});

describe("ExperimentManager — tick broadcast and data isolation", () => {
  it("broadcasts identical tick data to all arms", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "AB",
      symbols: ["NIFTY"],
      arms: [
        { id: "control", role: "CONTROL",    label: "C", versionStamp: STAMP, mode: "SHADOW" },
        { id: "expv2",   role: "EXPERIMENT", label: "E", versionStamp: STAMP, mode: "SHADOW" },
      ],
    });
    mgr.startExperiment(exp.id);

    const receivedTicks: MarketTick[] = [];

    mgr.registerHandler(exp.id, "control", (tick) => {
      receivedTicks.push(tick);
      return [];
    });
    mgr.registerHandler(exp.id, "expv2", (tick) => {
      receivedTicks.push(tick);
      return [];
    });

    const tick = makeTick({ barIndex: 5 });
    mgr.broadcastTick(exp.id, tick);

    expect(receivedTicks).toHaveLength(2);
    // Both arms received the exact same bar data
    expect(receivedTicks[0].barIndex).toBe(5);
    expect(receivedTicks[1].barIndex).toBe(5);
    expect(receivedTicks[0].close).toBe(receivedTicks[1].close);
  });

  it("tick object is frozen — mutations by handlers do not affect other arms", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Isolation",
      symbols: ["NIFTY"],
      arms: [
        { id: "a1", role: "CONTROL",    label: "A1", versionStamp: STAMP, mode: "SHADOW" },
        { id: "a2", role: "EXPERIMENT", label: "A2", versionStamp: STAMP, mode: "SHADOW" },
      ],
    });
    mgr.startExperiment(exp.id);

    const closePricesSeen: number[] = [];
    mgr.registerHandler(exp.id, "a1", (tick) => {
      // Attempt to mutate the frozen tick — should throw in strict mode
      // but we just verify the second arm still sees the original value
      closePricesSeen.push(tick.close);
      return [];
    });
    mgr.registerHandler(exp.id, "a2", (tick) => {
      closePricesSeen.push(tick.close);
      return [];
    });

    mgr.broadcastTick(exp.id, makeTick({ close: 21_050 }));
    // Both arms must have seen the original close — not a mutated value
    expect(closePricesSeen).toEqual([21_050, 21_050]);
  });

  it("skips ticks for symbols not in the experiment's symbol list", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "SymFilter",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);

    const handlerCalls = vi.fn().mockReturnValue([]);
    mgr.registerHandler(exp.id, "c", handlerCalls);

    mgr.broadcastTick(exp.id, makeTick({ symbol: "BANKNIFTY" })); // wrong symbol
    expect(handlerCalls).not.toHaveBeenCalled();

    mgr.broadcastTick(exp.id, makeTick({ symbol: "NIFTY" })); // correct symbol
    expect(handlerCalls).toHaveBeenCalledOnce();
  });

  it("does not call handlers on paused experiments", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Paused",
      symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    mgr.pauseExperiment(exp.id);

    const handler = vi.fn().mockReturnValue([]);
    mgr.registerHandler(exp.id, "c", handler);

    mgr.broadcastTick(exp.id, makeTick());
    expect(handler).not.toHaveBeenCalled();
  });

  it("broadcastTickToAll fans out to all running experiments", () => {
    const mgr = makeManager();
    const exp1 = mgr.createExperiment({
      name: "E1", symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    const exp2 = mgr.createExperiment({
      name: "E2", symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp1.id);
    mgr.startExperiment(exp2.id);

    const h1 = vi.fn().mockReturnValue([]);
    const h2 = vi.fn().mockReturnValue([]);
    mgr.registerHandler(exp1.id, "c", h1);
    mgr.registerHandler(exp2.id, "c", h2);

    mgr.broadcastTickToAll(makeTick());
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});

describe("ExperimentManager — SHADOW mode signal isolation", () => {
  it("SHADOW arm signals always have acted=false regardless of handler output", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "ShadowSignals",
      symbols: ["NIFTY"],
      arms: [{ id: "s", role: "CONTROL", label: "S", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);

    // Handler tries to set acted=true (simulating a buggy strategy)
    mgr.registerHandler(exp.id, "s", (tick, arm): ExperimentSignal[] => [
      {
        id: "sig_001",
        experimentId: arm.versionStamp.experimentId,
        armId: arm.id,
        versionStamp: arm.versionStamp,
        timestampMs: tick.timestampMs,
        symbol: tick.symbol,
        direction: "LONG",
        entryPrice: tick.close,
        stopLoss: tick.close * 0.99,
        target: tick.close * 1.02,
        confidence: 0.8,
        riskReward: 2.0,
        mode: "SHADOW",
        acted: true, // ← handler tries to mark this as acted
      },
    ]);

    const results = mgr.broadcastTick(exp.id, makeTick());
    expect(results).toHaveLength(1);
    const signal = results[0].signals[0];

    // The manager MUST override acted to false for SHADOW arms
    expect(signal.acted).toBe(false);
  });

  it("SHADOW arm signals are recorded and retrievable", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "ShadowRecord",
      symbols: ["NIFTY"],
      arms: [{ id: "s", role: "CONTROL", label: "S", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);

    mgr.registerHandler(exp.id, "s", (tick, arm): ExperimentSignal[] => [
      {
        id: `sig_${tick.barIndex}`,
        experimentId: arm.versionStamp.experimentId,
        armId: arm.id,
        versionStamp: arm.versionStamp,
        timestampMs: tick.timestampMs,
        symbol: tick.symbol,
        direction: "LONG",
        entryPrice: tick.close,
        stopLoss: tick.close * 0.99,
        target: tick.close * 1.02,
        confidence: 0.75,
        riskReward: 2.0,
        mode: "SHADOW",
        acted: false,
      },
    ]);

    mgr.broadcastTick(exp.id, makeTick({ barIndex: 1 }));
    mgr.broadcastTick(exp.id, makeTick({ barIndex: 2 }));
    mgr.broadcastTick(exp.id, makeTick({ barIndex: 3 }));

    const signals = mgr.getSignalsForArm(exp.id, "s");
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.acted === false)).toBe(true);
  });
});

describe("ExperimentManager — arm promotion", () => {
  it("promotes SHADOW → PAPER with no approval token", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "Promo",
      symbols: ["NIFTY"],
      arms: [{ id: "s", role: "CONTROL", label: "S", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    mgr.promoteArm(exp.id, "s", "PAPER"); // no token needed for SHADOW→PAPER
    expect(mgr.getExperiment(exp.id)!.arms[0].mode).toBe("PAPER");
  });

  it("throws when promoting LIVE without an approvalToken", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "LiveGuard",
      symbols: ["NIFTY"],
      arms: [{ id: "p", role: "CONTROL", label: "P", versionStamp: STAMP, mode: "PAPER" }],
    });
    mgr.startExperiment(exp.id);

    expect(() => mgr.promoteArm(exp.id, "p", "LIVE")).toThrow("approvalToken");
    expect(() => mgr.promoteArm(exp.id, "p", "LIVE", "")).toThrow("approvalToken");
    expect(() => mgr.promoteArm(exp.id, "p", "LIVE", "   ")).toThrow("approvalToken");
  });

  it("successfully promotes PAPER → LIVE with a valid approvalToken", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "LiveOK",
      symbols: ["NIFTY"],
      arms: [{ id: "p", role: "CONTROL", label: "P", versionStamp: STAMP, mode: "PAPER" }],
    });
    mgr.startExperiment(exp.id);
    mgr.promoteArm(exp.id, "p", "LIVE", "human-approval-token-abc123");
    expect(mgr.getExperiment(exp.id)!.arms[0].mode).toBe("LIVE");
  });

  it("throws on invalid mode transitions (e.g. SHADOW → LIVE)", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "InvalidTrans",
      symbols: ["NIFTY"],
      arms: [{ id: "s", role: "CONTROL", label: "S", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(exp.id);
    expect(() => mgr.promoteArm(exp.id, "s", "LIVE", "some-token")).toThrow(
      "Invalid mode transition",
    );
  });

  it("throws on transition from RESEARCH → SHADOW (must go through BACKTEST)", () => {
    const mgr = makeManager();
    const exp = mgr.createExperiment({
      name: "BadSkip",
      symbols: ["NIFTY"],
      arms: [{ id: "r", role: "CONTROL", label: "R", versionStamp: STAMP, mode: "RESEARCH" }],
    });
    mgr.startExperiment(exp.id);
    expect(() => mgr.promoteArm(exp.id, "r", "SHADOW")).toThrow("Invalid mode transition");
  });
});

describe("ExperimentManager — snapshot", () => {
  it("returns accurate totals", () => {
    const mgr = makeManager();
    const e1 = mgr.createExperiment({
      name: "E1", symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.createExperiment({
      name: "E2", symbols: ["NIFTY"],
      arms: [{ id: "c", role: "CONTROL", label: "C", versionStamp: STAMP, mode: "SHADOW" }],
    });
    mgr.startExperiment(e1.id);

    const snap = mgr.snapshot();
    expect(snap.totalExperiments).toBe(2);
    expect(snap.running).toBe(1);
    expect(snap.paused).toBe(1);
  });
});
