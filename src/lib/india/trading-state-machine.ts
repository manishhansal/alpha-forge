/**
 * TradingStateMachine — Phase 10
 *
 * Formalizes the order lifecycle with explicit state transitions.
 * Invalid transitions fail loudly — never silently corrupt state.
 *
 * States:
 *   NEW → VALIDATED → RISK_APPROVED → SUBMITTED → PARTIALLY_FILLED
 *   → FILLED → REJECTED | CANCELLED | FAILED
 *
 * Design:
 *   - Transitions are validated against a legal transition map.
 *   - Every transition records a timestamp and reason.
 *   - Terminal states (FILLED, REJECTED, CANCELLED, FAILED) cannot transition further.
 */

// ─── States ──────────────────────────────────────────────────────────────────

export type OrderState =
  | "NEW"
  | "VALIDATED"
  | "RISK_APPROVED"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED"
  | "FAILED";

/** Terminal states — no further transitions allowed. */
const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
  "FILLED",
  "REJECTED",
  "CANCELLED",
  "FAILED",
]);

/** Legal transitions: state → set of allowed next states. */
const LEGAL_TRANSITIONS: Readonly<Record<OrderState, ReadonlySet<OrderState>>> = {
  NEW: new Set(["VALIDATED", "REJECTED", "CANCELLED"]),
  VALIDATED: new Set(["RISK_APPROVED", "REJECTED", "CANCELLED"]),
  RISK_APPROVED: new Set(["SUBMITTED", "REJECTED", "CANCELLED"]),
  SUBMITTED: new Set(["PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "FAILED"]),
  PARTIALLY_FILLED: new Set(["FILLED", "CANCELLED", "FAILED"]),
  FILLED: new Set(), // terminal
  REJECTED: new Set(), // terminal
  CANCELLED: new Set(), // terminal
  FAILED: new Set(), // terminal
};

// ─── Order record ─────────────────────────────────────────────────────────────

export type FillRecord = {
  fillId: string;
  quantity: number;
  price: number;
  timestamp: string; // ISO-8601
};

export interface OrderRecord {
  orderId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  state: OrderState;
  /** History of all state transitions. */
  transitions: Array<{
    from: OrderState;
    to: OrderState;
    at: string;       // ISO-8601
    reason: string;
  }>;
  fills: FillRecord[];
  filledQuantity: number;
  avgFillPrice: number | null;
  rejectionReason: string | null;
  failureReason: string | null;
  createdAt: string;  // ISO-8601
  updatedAt: string;  // ISO-8601
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly from: OrderState,
    public readonly to: OrderState,
  ) {
    super(
      `Invalid state transition for order ${orderId}: ${from} → ${to}. ` +
        `Legal transitions from ${from}: ${[...LEGAL_TRANSITIONS[from]].join(", ") || "(none — terminal state)"}`,
    );
    this.name = "InvalidStateTransitionError";
  }
}

export class DuplicateFillError extends Error {
  constructor(public readonly orderId: string, public readonly fillId: string) {
    super(`Duplicate fill ${fillId} on order ${orderId}`);
    this.name = "DuplicateFillError";
  }
}

export class FillAfterTerminalStateError extends Error {
  constructor(public readonly orderId: string, public readonly state: OrderState) {
    super(`Cannot apply fill to order ${orderId} in terminal state ${state}`);
    this.name = "FillAfterTerminalStateError";
  }
}

// ─── State Machine ────────────────────────────────────────────────────────────

export class TradingStateMachine {
  private readonly order: OrderRecord;

  constructor(order: OrderRecord) {
    this.order = { ...order };
  }

  get currentState(): OrderState {
    return this.order.state;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.order.state);
  }

  get snapshot(): Readonly<OrderRecord> {
    return { ...this.order, transitions: [...this.order.transitions], fills: [...this.order.fills] };
  }

  /**
   * Attempt a state transition. Throws InvalidStateTransitionError for illegal moves.
   */
  transition(to: OrderState, reason: string): void {
    const from = this.order.state;

    if (!LEGAL_TRANSITIONS[from].has(to)) {
      throw new InvalidStateTransitionError(this.order.orderId, from, to);
    }

    const at = new Date().toISOString();
    this.order.transitions.push({ from, to, at, reason });
    this.order.state = to;
    this.order.updatedAt = at;
  }

  /**
   * Apply a fill to the order.
   * Throws FillAfterTerminalStateError when the order is already in a terminal state.
   * Throws DuplicateFillError when the fillId has already been applied.
   * Automatically advances to FILLED when filledQuantity >= quantity.
   */
  applyFill(fill: FillRecord): void {
    if (TERMINAL_STATES.has(this.order.state)) {
      throw new FillAfterTerminalStateError(this.order.orderId, this.order.state);
    }

    // Check for duplicate fill
    if (this.order.fills.some((f) => f.fillId === fill.fillId)) {
      throw new DuplicateFillError(this.order.orderId, fill.fillId);
    }

    // Ensure we're in a fillable state
    if (
      this.order.state !== "SUBMITTED" &&
      this.order.state !== "PARTIALLY_FILLED"
    ) {
      throw new InvalidStateTransitionError(
        this.order.orderId,
        this.order.state,
        "PARTIALLY_FILLED",
      );
    }

    this.order.fills.push(fill);
    this.order.filledQuantity += fill.quantity;

    // Recompute average fill price
    const totalValue = this.order.fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
    this.order.avgFillPrice = totalValue / this.order.filledQuantity;

    const at = new Date().toISOString();
    this.order.updatedAt = at;

    if (this.order.filledQuantity >= this.order.quantity) {
      // Fully filled
      this.transition("FILLED", `Fully filled: ${fill.fillId}`);
    } else {
      // Partial fill — transition SUBMITTED → PARTIALLY_FILLED
      if (this.order.state === "SUBMITTED") {
        this.transition("PARTIALLY_FILLED", `Partial fill: ${fill.fillId}`);
      }
    }
  }

  /**
   * Reject the order.
   */
  reject(reason: string): void {
    this.transition("REJECTED", reason);
    this.order.rejectionReason = reason;
  }

  /**
   * Cancel the order.
   */
  cancel(reason: string): void {
    this.transition("CANCELLED", reason);
  }

  /**
   * Mark the order as failed (e.g. broker connectivity failure).
   */
  fail(reason: string): void {
    this.transition("FAILED", reason);
    this.order.failureReason = reason;
  }

  // ── Static factory ──────────────────────────────────────────────────────────

  /**
   * Create a new order in the NEW state.
   */
  static create(params: {
    orderId: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    quantity: number;
    entryPrice: number;
    stopLoss: number;
    target: number;
  }): TradingStateMachine {
    const now = new Date().toISOString();
    const order: OrderRecord = {
      ...params,
      state: "NEW",
      transitions: [],
      fills: [],
      filledQuantity: 0,
      avgFillPrice: null,
      rejectionReason: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    return new TradingStateMachine(order);
  }

  // ── Validation helpers ──────────────────────────────────────────────────────

  /** Check if a transition from the current state to `to` is legal. */
  canTransition(to: OrderState): boolean {
    return LEGAL_TRANSITIONS[this.order.state].has(to);
  }
}

// ─── Export legal transitions for tests ──────────────────────────────────────

export { LEGAL_TRANSITIONS, TERMINAL_STATES };
