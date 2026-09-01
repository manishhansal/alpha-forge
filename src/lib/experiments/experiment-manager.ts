/**
 * experiment-manager.ts — Experiment Lifecycle Manager
 *
 * Central registry and state machine for all strategy experiments.
 *
 * An Experiment wraps:
 *   • A strategy variant (control or experiment arm)
 *   • The mode it runs in: RESEARCH → BACKTEST → SHADOW → PAPER → LIVE
 *   • Optional A/B pairing: a "control" and one or more "experiment" arms
 *     that receive identical market data feeds
 *   • A ShadowTrader instance for SHADOW-mode arms (zero order impact)
 *
 * State machine
 * ─────────────
 *   RESEARCH → BACKTEST → SHADOW → PAPER → LIVE
 *
 * Rules enforced here (see promotion.ts for the gate logic):
 *   • SHADOW → PAPER  requires minimum sample size (enforced by PromotionEngine)
 *   • PAPER  → LIVE   requires explicit human approval token (NEVER automatic)
 *   • Experiments in SHADOW mode NEVER touch the paper or live portfolio
 *
 * A/B testing
 * ───────────
 * An ABExperiment groups one CONTROL arm and 1..N EXPERIMENT arms.
 * The manager broadcasts every MarketTick to all arms simultaneously,
 * guaranteeing identical data. Results are compared via ComparisonEngine.
 */

import type { VersionStamp, VersionStage } from "./strategy-version";

// ── Modes ──────────────────────────────────────────────────────────────────────

export type ExperimentMode =
  | "RESEARCH"   // No execution — ideation / development phase
  | "BACKTEST"   // Historical replay only
  | "SHADOW"     // Live data → signals → simulated fills, zero portfolio impact
  | "PAPER"      // Paper portfolio impact, no real money
  | "LIVE";      // Real orders — requires explicit human promotion

// ── Market tick (the unit of data fed to each arm) ────────────────────────────

/**
 * A normalised market tick that the ExperimentManager broadcasts to all
 * active experiment arms. Mirrors the fields strategies actually need so
 * the experiment layer stays decoupled from the full EventEngine OHLCV types.
 */
export interface MarketTick {
  /** UTC epoch ms — the bar close time. */
  timestampMs: number;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Sequential bar index — monotonically increasing per symbol. */
  barIndex: number;
  /** Additional fields (ATR, OI, IV, PCR, etc.) the strategy may read. */
  extras?: Record<string, number | string | boolean | null>;
}

// ── Signal produced by an experiment arm ──────────────────────────────────────

export type SignalDirection = "LONG" | "SHORT" | "FLAT";

export interface ExperimentSignal {
  /** Unique signal id. */
  id: string;
  /** The experiment this signal belongs to. */
  experimentId: string;
  /** The specific arm (CONTROL / EXPERIMENT_n). */
  armId: string;
  /** Full version provenance. */
  versionStamp: VersionStamp;
  timestampMs: number;
  symbol: string;
  direction: SignalDirection;
  entryPrice: number;
  stopLoss: number;
  target: number;
  confidence: number;
  /** Risk/reward ratio at signal time. */
  riskReward: number;
  /** Mode the arm was in when this signal fired. */
  mode: ExperimentMode;
  /** Whether this signal was actually acted on (false in SHADOW mode). */
  acted: boolean;
}

// ── Simulated fill ─────────────────────────────────────────────────────────────

export interface SimulatedFill {
  signalId: string;
  experimentId: string;
  armId: string;
  timestampMs: number;
  symbol: string;
  direction: SignalDirection;
  entryPrice: number;
  qty: number;
  commission: number;
  slippage: number;
  /** Always false — fills in shadow mode never touch a real or paper portfolio. */
  isReal: false;
}

// ── Arm definition ─────────────────────────────────────────────────────────────

export type ArmRole = "CONTROL" | "EXPERIMENT";

export interface ExperimentArm {
  /** Unique arm id within the experiment (e.g. "control", "arm-v2"). */
  id: string;
  role: ArmRole;
  /** Human label for dashboards. */
  label: string;
  versionStamp: VersionStamp;
  mode: ExperimentMode;
  /** UTC ms when this arm was created. */
  createdAtMs: number;
  /** UTC ms of last signal received. */
  lastTickMs: number | null;
  /** Count of signals generated so far. */
  signalCount: number;
  /** Count of signals that resolved to a closed simulated trade. */
  closedTradeCount: number;
  /** Whether this arm is currently accepting ticks. */
  active: boolean;
}

// ── Experiment definition ──────────────────────────────────────────────────────

export type ExperimentStatus =
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "ARCHIVED";

export interface Experiment {
  /** Unique experiment id. */
  id: string;
  /** Human name. */
  name: string;
  description?: string;
  /** Symbols this experiment observes. */
  symbols: string[];
  /** Arms in this experiment. */
  arms: ExperimentArm[];
  status: ExperimentStatus;
  /** UTC ms when the experiment was created. */
  createdAtMs: number;
  /** UTC ms when the experiment was last updated. */
  updatedAtMs: number;
  /** UTC ms when the experiment was started (first tick processed). */
  startedAtMs: number | null;
  /** UTC ms when the experiment ended (completed/failed). */
  endedAtMs: number | null;
  /** Optional baseline version stamp for benchmark comparison. */
  benchmarkStamp?: VersionStamp;
  /** Free-form tags for filtering (e.g. ["ml-v3", "nifty", "breakout"]). */
  tags?: string[];
}

// ── Create / update inputs ─────────────────────────────────────────────────────

export interface CreateExperimentInput {
  name: string;
  description?: string;
  symbols: string[];
  /** At least one arm must be provided (usually CONTROL + 1 EXPERIMENT). */
  arms: Array<{
    id: string;
    role: ArmRole;
    label: string;
    versionStamp: VersionStamp;
    mode: ExperimentMode;
  }>;
  benchmarkStamp?: VersionStamp;
  tags?: string[];
}

export interface AddArmInput {
  id: string;
  role: ArmRole;
  label: string;
  versionStamp: VersionStamp;
  mode: ExperimentMode;
}

// ── Tick result ────────────────────────────────────────────────────────────────

/**
 * Per-arm result returned after broadcasting a tick.
 * The caller (e.g. a worker job) can inspect signals without the manager
 * needing to know anything about strategy execution.
 */
export interface ArmTickResult {
  armId: string;
  experimentId: string;
  tickProcessed: boolean;
  /** Signals the arm handler chose to emit for this tick (may be empty). */
  signals: ExperimentSignal[];
}

// ── Strategy handler ───────────────────────────────────────────────────────────

/**
 * A strategy handler is a pure function that receives market ticks and
 * returns zero or more signals. The manager calls this for each active arm.
 *
 * Implementations should be stateless between calls (maintain state inside
 * a closure if needed) and must NEVER produce side effects that touch orders
 * or portfolios — that contract is enforced by the ExperimentManager wrapper.
 */
export type ArmStrategyHandler = (
  tick: MarketTick,
  arm: ExperimentArm,
) => ExperimentSignal[];

// ── ExperimentManager ──────────────────────────────────────────────────────────

export class ExperimentManager {
  private readonly _experiments = new Map<string, Experiment>();
  private readonly _handlers = new Map<string, ArmStrategyHandler>();

  /** All signals emitted (across all experiments and arms). */
  private readonly _signals: ExperimentSignal[] = [];

  /** All simulated fills (shadow/paper arms only). */
  private readonly _fills: SimulatedFill[] = [];

  // ── Experiment CRUD ────────────────────────────────────────────────────

  /**
   * Create and register a new experiment.
   * Arms start inactive; call `startExperiment()` to begin processing ticks.
   */
  createExperiment(input: CreateExperimentInput): Experiment {
    if (input.arms.length === 0) {
      throw new Error("[ExperimentManager] At least one arm is required");
    }

    // Every experiment must have at most one CONTROL arm.
    const controlArms = input.arms.filter((a) => a.role === "CONTROL");
    if (controlArms.length > 1) {
      throw new Error("[ExperimentManager] Only one CONTROL arm is allowed per experiment");
    }

    const id = makeExperimentId();
    const now = Date.now();

    const arms: ExperimentArm[] = input.arms.map((a) => ({
      id: a.id,
      role: a.role,
      label: a.label,
      versionStamp: { ...a.versionStamp, experimentId: id },
      mode: a.mode,
      createdAtMs: now,
      lastTickMs: null,
      signalCount: 0,
      closedTradeCount: 0,
      active: false,
    }));

    const experiment: Experiment = {
      id,
      name: input.name,
      description: input.description,
      symbols: input.symbols,
      arms,
      status: "PAUSED",
      createdAtMs: now,
      updatedAtMs: now,
      startedAtMs: null,
      endedAtMs: null,
      benchmarkStamp: input.benchmarkStamp,
      tags: input.tags,
    };

    this._experiments.set(id, experiment);
    return experiment;
  }

  getExperiment(id: string): Experiment | undefined {
    return this._experiments.get(id);
  }

  listExperiments(): Experiment[] {
    return Array.from(this._experiments.values());
  }

  listRunningExperiments(): Experiment[] {
    return this.listExperiments().filter((e) => e.status === "RUNNING");
  }

  addArm(experimentId: string, input: AddArmInput): ExperimentArm {
    const experiment = this._requireExperiment(experimentId);

    if (experiment.status !== "PAUSED" && experiment.status !== "RUNNING") {
      throw new Error(
        `[ExperimentManager] Cannot add arm to experiment in status ${experiment.status}`,
      );
    }

    const existing = experiment.arms.find((a) => a.id === input.id);
    if (existing) {
      throw new Error(
        `[ExperimentManager] Arm "${input.id}" already exists in experiment ${experimentId}`,
      );
    }

    const arm: ExperimentArm = {
      id: input.id,
      role: input.role,
      label: input.label,
      versionStamp: { ...input.versionStamp, experimentId },
      mode: input.mode,
      createdAtMs: Date.now(),
      lastTickMs: null,
      signalCount: 0,
      closedTradeCount: 0,
      active: experiment.status === "RUNNING",
    };

    experiment.arms.push(arm);
    experiment.updatedAtMs = Date.now();
    return arm;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  startExperiment(id: string): void {
    const experiment = this._requireExperiment(id);
    if (experiment.status === "RUNNING") return; // idempotent

    if (experiment.status === "COMPLETED" || experiment.status === "ARCHIVED") {
      throw new Error(
        `[ExperimentManager] Cannot restart experiment in status ${experiment.status}`,
      );
    }

    const now = Date.now();
    experiment.status = "RUNNING";
    experiment.startedAtMs ??= now;
    experiment.updatedAtMs = now;

    for (const arm of experiment.arms) {
      arm.active = true;
    }
  }

  pauseExperiment(id: string): void {
    const experiment = this._requireExperiment(id);
    if (experiment.status !== "RUNNING") return;

    experiment.status = "PAUSED";
    experiment.updatedAtMs = Date.now();

    for (const arm of experiment.arms) {
      arm.active = false;
    }
  }

  completeExperiment(id: string): void {
    const experiment = this._requireExperiment(id);
    const now = Date.now();
    experiment.status = "COMPLETED";
    experiment.endedAtMs = now;
    experiment.updatedAtMs = now;

    for (const arm of experiment.arms) {
      arm.active = false;
    }
  }

  failExperiment(id: string, reason?: string): void {
    const experiment = this._requireExperiment(id);
    const now = Date.now();
    experiment.status = "FAILED";
    experiment.endedAtMs = now;
    experiment.updatedAtMs = now;
    if (reason) experiment.description = `FAILED: ${reason}`;

    for (const arm of experiment.arms) {
      arm.active = false;
    }
  }

  archiveExperiment(id: string): void {
    const experiment = this._requireExperiment(id);
    if (experiment.status === "RUNNING") {
      throw new Error("[ExperimentManager] Stop the experiment before archiving");
    }
    experiment.status = "ARCHIVED";
    experiment.updatedAtMs = Date.now();
  }

  // ── Handler registration ───────────────────────────────────────────────

  /**
   * Register a strategy handler for a specific arm.
   * Key format: `${experimentId}:${armId}`.
   */
  registerHandler(
    experimentId: string,
    armId: string,
    handler: ArmStrategyHandler,
  ): void {
    const key = `${experimentId}:${armId}`;
    this._handlers.set(key, handler);
  }

  // ── Tick broadcasting ──────────────────────────────────────────────────

  /**
   * Broadcast a single market tick to all active arms of a running experiment.
   *
   * CRITICAL ISOLATION GUARANTEE:
   * ─────────────────────────────
   * • All arms receive an identical, frozen copy of the tick — no arm can
   *   mutate the tick object and affect other arms.
   * • Arms in SHADOW mode: signals are recorded but `acted = false`. No
   *   portfolio, order, or paper-trade mutation ever occurs.
   * • The manager never calls any order-routing, broker, or portfolio API.
   *   Those systems are the caller's responsibility if `acted = true`.
   *
   * Returns per-arm tick results so the caller can inspect signals.
   */
  broadcastTick(
    experimentId: string,
    tick: MarketTick,
  ): ArmTickResult[] {
    const experiment = this._experiments.get(experimentId);
    if (!experiment || experiment.status !== "RUNNING") return [];

    // Deep-freeze the tick so no arm handler can mutate shared state.
    const frozenTick: MarketTick = Object.freeze({
      ...tick,
      extras: tick.extras ? Object.freeze({ ...tick.extras }) : undefined,
    });

    const results: ArmTickResult[] = [];

    for (const arm of experiment.arms) {
      if (!arm.active) continue;
      if (!experiment.symbols.includes(tick.symbol)) continue;

      const handlerKey = `${experimentId}:${arm.id}`;
      const handler = this._handlers.get(handlerKey);

      if (!handler) {
        results.push({ armId: arm.id, experimentId, tickProcessed: false, signals: [] });
        continue;
      }

      let signals: ExperimentSignal[] = [];
      try {
        const raw = handler(frozenTick, arm);

        // Enforce mode isolation: SHADOW arms always have acted=false.
        signals = raw.map((s) => ({
          ...s,
          experimentId,
          armId: arm.id,
          mode: arm.mode,
          acted: arm.mode === "SHADOW" ? false : s.acted,
          versionStamp: { ...arm.versionStamp },
        }));
      } catch (err) {
        console.error(
          `[ExperimentManager] Handler error in ${experimentId}:${arm.id}:`,
          err,
        );
      }

      arm.lastTickMs = tick.timestampMs;
      arm.signalCount += signals.length;
      this._signals.push(...signals);

      results.push({ armId: arm.id, experimentId, tickProcessed: true, signals });
    }

    return results;
  }

  /**
   * Broadcast the same tick to ALL running experiments simultaneously.
   * This is the primary entry point for a live market-data worker.
   */
  broadcastTickToAll(tick: MarketTick): Map<string, ArmTickResult[]> {
    const output = new Map<string, ArmTickResult[]>();
    for (const experiment of this._experiments.values()) {
      if (experiment.status !== "RUNNING") continue;
      if (!experiment.symbols.includes(tick.symbol)) continue;
      output.set(experiment.id, this.broadcastTick(experiment.id, tick));
    }
    return output;
  }

  // ── Signal access ──────────────────────────────────────────────────────

  getSignalsForExperiment(experimentId: string): ExperimentSignal[] {
    return this._signals.filter((s) => s.experimentId === experimentId);
  }

  getSignalsForArm(experimentId: string, armId: string): ExperimentSignal[] {
    return this._signals.filter(
      (s) => s.experimentId === experimentId && s.armId === armId,
    );
  }

  getAllSignals(): ExperimentSignal[] {
    return [...this._signals];
  }

  // ── Arm mode transitions ───────────────────────────────────────────────

  /**
   * Update the mode for a specific arm.
   * Called by PromotionEngine after approval gates are satisfied.
   *
   * LIVE promotion is never called automatically by this manager —
   * it requires an explicit human-supplied `approvalToken`.
   */
  promoteArm(
    experimentId: string,
    armId: string,
    targetMode: ExperimentMode,
    approvalToken?: string,
  ): void {
    const experiment = this._requireExperiment(experimentId);
    const arm = this._requireArm(experiment, armId);

    if (targetMode === "LIVE") {
      if (!approvalToken || approvalToken.trim().length === 0) {
        throw new Error(
          "[ExperimentManager] LIVE promotion requires an explicit approvalToken — " +
            "auto-promotion to LIVE is strictly forbidden",
        );
      }
    }

    const validTransitions: Record<ExperimentMode, ExperimentMode[]> = {
      RESEARCH: ["BACKTEST"],
      BACKTEST: ["SHADOW"],
      SHADOW: ["PAPER"],
      PAPER: ["LIVE"],
      LIVE: [],
    };

    if (!validTransitions[arm.mode].includes(targetMode)) {
      throw new Error(
        `[ExperimentManager] Invalid mode transition: ${arm.mode} → ${targetMode}`,
      );
    }

    arm.mode = targetMode;
    experiment.updatedAtMs = Date.now();
  }

  // ── Stage update (propagates to version registry caller) ──────────────

  updateArmStage(
    experimentId: string,
    armId: string,
    stage: VersionStage,
  ): void {
    const experiment = this._requireExperiment(experimentId);
    const arm = this._requireArm(experiment, armId);
    // Keep the stage in sync with the version stamp label (informational).
    arm.versionStamp = { ...arm.versionStamp };
    experiment.updatedAtMs = Date.now();
    void stage; // consumed by caller to update the version registry
  }

  // ── Snapshot for dashboard API ─────────────────────────────────────────

  snapshot(): ExperimentManagerSnapshot {
    const experiments = this.listExperiments();
    return {
      totalExperiments: experiments.length,
      running: experiments.filter((e) => e.status === "RUNNING").length,
      paused: experiments.filter((e) => e.status === "PAUSED").length,
      completed: experiments.filter((e) => e.status === "COMPLETED").length,
      failed: experiments.filter((e) => e.status === "FAILED").length,
      totalSignals: this._signals.length,
      experiments,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private _requireExperiment(id: string): Experiment {
    const experiment = this._experiments.get(id);
    if (!experiment) {
      throw new Error(`[ExperimentManager] Unknown experiment: ${id}`);
    }
    return experiment;
  }

  private _requireArm(experiment: Experiment, armId: string): ExperimentArm {
    const arm = experiment.arms.find((a) => a.id === armId);
    if (!arm) {
      throw new Error(
        `[ExperimentManager] Unknown arm "${armId}" in experiment ${experiment.id}`,
      );
    }
    return arm;
  }
}

// ── Snapshot type ──────────────────────────────────────────────────────────────

export interface ExperimentManagerSnapshot {
  totalExperiments: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  totalSignals: number;
  experiments: Experiment[];
}

// ── ID generation ──────────────────────────────────────────────────────────────

let _expCounter = 0;

function makeExperimentId(): string {
  const ts = Date.now().toString(36);
  const seq = (++_expCounter).toString(36).padStart(4, "0");
  return `exp_${ts}_${seq}`;
}

// ── Module-level singleton ─────────────────────────────────────────────────────

export const globalExperimentManager = new ExperimentManager();
