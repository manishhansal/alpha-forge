/**
 * Signal execution mode (remediation P0/P1 — Phase 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Controls how much authority the new signal-intelligence stack has over real
 * execution. The default is SHADOW: the new stack computes and persists a
 * decision alongside the legacy path but NEVER alters what actually trades.
 *
 *   LEGACY               — new stack disabled; legacy path is authoritative.
 *   SHADOW  (default)    — new stack runs + persists for comparison ONLY;
 *                          execution is unchanged (legacy still trades).
 *   PAPER                — new stack may control PAPER execution (no capital);
 *                          requires shadow validation first.
 *   PRODUCTION_CANDIDATE — new stack eligible for live once all gates pass.
 *
 * Production is intentionally NOT a mode here: automatic live enablement is
 * forbidden. Promotion to live is a separate, deliberate human action gated by
 * `promotion-gates.ts`.
 */

export const SIGNAL_MODE_VERSION = "smode-1.0.0";

export type SignalMode = "LEGACY" | "SHADOW" | "PAPER" | "PRODUCTION_CANDIDATE";

/** Safe default: new stack observes only, never executes. */
export const DEFAULT_SIGNAL_MODE: SignalMode = "SHADOW";

/**
 * Resolve the active mode from the environment, defaulting to SHADOW. An
 * unrecognised value falls back to SHADOW (fail-safe — never LEGACY-blind and
 * never straight to execution).
 */
export function resolveSignalMode(env: NodeJS.ProcessEnv = process.env): SignalMode {
  const raw = (env.INDIA_SIGNAL_MODE ?? "").toUpperCase().trim();
  if (raw === "LEGACY" || raw === "SHADOW" || raw === "PAPER" || raw === "PRODUCTION_CANDIDATE") {
    return raw;
  }
  return DEFAULT_SIGNAL_MODE;
}

/** May the new stack alter real (paper or live) execution in this mode? */
export function newStackControlsExecution(mode: SignalMode): boolean {
  return mode === "PAPER" || mode === "PRODUCTION_CANDIDATE";
}

/** Is the new stack computed at all in this mode? (Everything except LEGACY.) */
export function newStackActive(mode: SignalMode): boolean {
  return mode !== "LEGACY";
}
