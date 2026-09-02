"use client";

/**
 * Missed Signal Card
 *
 * Displays the highest-value opportunities that were NOT captured by
 * paper trading. This is one of the most important diagnostic panels
 * in the system — it answers "What did we leave on the table?"
 *
 * Phase 11 / 59 of the 64-phase production truth validation:
 *   - Missed Opportunity Detector
 *   - Missed Signal Card
 *
 * Every missed high-value opportunity must have an identified failure layer:
 *   DETECTION_FAILURE | FEATURE_FAILURE | SIGNAL_FAILURE | QUALITY_FILTER_FAILURE
 *   RISK_GATE_FAILURE | EXECUTION_FAILURE | PAPER_ENGINE_FAILURE | DATA_FAILURE
 *   WORKER_FAILURE | LATENCY_FAILURE | DUPLICATION_FAILURE
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type MissedSignalFailureLayer =
  | "DETECTION_FAILURE"
  | "FEATURE_FAILURE"
  | "SIGNAL_FAILURE"
  | "QUALITY_FILTER_FAILURE"
  | "RISK_GATE_FAILURE"
  | "EXECUTION_FAILURE"
  | "PAPER_ENGINE_FAILURE"
  | "DATA_FAILURE"
  | "WORKER_FAILURE"
  | "LATENCY_FAILURE"
  | "DUPLICATION_FAILURE"
  | "BUDGET_EXHAUSTED"
  | "UNKNOWN";

export interface MissedSignalRecord {
  instrument: string;
  strategyId: string;
  direction: "LONG" | "SHORT";
  /** Quality tier the signal would have received */
  expectedQualityTier: "A_PLUS" | "A" | "B" | "C";
  /** Expected EV at time of miss */
  expectedEV: number;
  /** Actual outcome after the miss window */
  actualOutcome: "WIN" | "LOSS" | "EXPIRED" | "UNKNOWN";
  /** Actual P&L% if outcome is known */
  actualPnlPct: number | null;
  /** Pipeline stage where the signal was lost */
  failureLayer: MissedSignalFailureLayer;
  /** Human-readable explanation */
  failureReason: string;
  /** Suggested fix */
  fixRequired: string;
  /** Timestamp of the missed opportunity */
  missedAt: number;
  sessionDate: string;
}

interface Props {
  missedSignals: MissedSignalRecord[];
  sessionDate: string;
}

const FAILURE_LAYER_LABELS: Record<MissedSignalFailureLayer, string> = {
  DETECTION_FAILURE:      "Not detected",
  FEATURE_FAILURE:        "Feature missing",
  SIGNAL_FAILURE:         "Signal not generated",
  QUALITY_FILTER_FAILURE: "Quality gate rejected",
  RISK_GATE_FAILURE:      "Risk gate rejected",
  EXECUTION_FAILURE:      "Execution failed",
  PAPER_ENGINE_FAILURE:   "Paper engine failure",
  DATA_FAILURE:           "Data unavailable",
  WORKER_FAILURE:         "Worker not running",
  LATENCY_FAILURE:        "Too late — move gone",
  DUPLICATION_FAILURE:    "Blocked by duplicate guard",
  BUDGET_EXHAUSTED:       "Budget exhausted",
  UNKNOWN:                "Unknown",
};

function layerColor(layer: MissedSignalFailureLayer) {
  if (layer === "RISK_GATE_FAILURE" || layer === "QUALITY_FILTER_FAILURE") return "var(--color-warning)";
  if (layer === "DETECTION_FAILURE" || layer === "DATA_FAILURE" || layer === "WORKER_FAILURE") return "var(--color-bear)";
  if (layer === "BUDGET_EXHAUSTED" || layer === "DUPLICATION_FAILURE") return "var(--color-fg-muted)";
  return "var(--color-bear)";
}

function outcomeColor(outcome: MissedSignalRecord["actualOutcome"]) {
  if (outcome === "WIN") return "var(--color-bull)";
  if (outcome === "LOSS") return "var(--color-bear)";
  return "var(--color-fg-muted)";
}

function tierBadgeColor(tier: MissedSignalRecord["expectedQualityTier"]) {
  if (tier === "A_PLUS") return { bg: "color-mix(in oklch, var(--color-bull) 15%, transparent)", text: "var(--color-bull)" };
  if (tier === "A") return { bg: "color-mix(in oklch, var(--color-brand) 15%, transparent)", text: "var(--color-brand)" };
  return { bg: "var(--color-surface-hover)", text: "var(--color-fg-muted)" };
}

export function MissedSignalCard({ missedSignals, sessionDate }: Props) {
  const sortedByEV = [...missedSignals].sort((a, b) => b.expectedEV - a.expectedEV);
  const highValueMissed = sortedByEV.filter((m) => m.expectedQualityTier === "A_PLUS" || m.expectedQualityTier === "A");
  const totalMissedWins = missedSignals.filter((m) => m.actualOutcome === "WIN").length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">
              Missed High-Value Signals
            </CardTitle>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              Session: {sessionDate} — opportunities not captured by paper trading
            </p>
          </div>
          <div className="text-right text-[11px]">
            {totalMissedWins > 0 && (
              <span
                className="rounded px-2 py-1 text-[10px] font-semibold"
                style={{
                  background: "color-mix(in oklch, var(--color-bear) 15%, transparent)",
                  color: "var(--color-bear)",
                }}
              >
                {totalMissedWins} missed wins
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {missedSignals.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-[13px] font-medium" style={{ color: "var(--color-fg-muted)" }}>
              No missed signal data available
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              Requires SignalLifecycleEvent DB persistence (AUDIT-001).
              Deploy the fix and allow one full session to populate data.
            </p>
          </div>
        ) : (
          <>
            {/* High-value callout */}
            {highValueMissed.length > 0 && (
              <div
                className="rounded-md border px-3 py-2 text-[11px]"
                style={{
                  borderColor: "color-mix(in oklch, var(--color-bear) 40%, transparent)",
                  background: "color-mix(in oklch, var(--color-bear) 5%, transparent)",
                }}
              >
                <strong style={{ color: "var(--color-bear)" }}>
                  {highValueMissed.length} A+/A quality signal{highValueMissed.length > 1 ? "s" : ""} missed
                </strong>
                <span style={{ color: "var(--color-fg-muted)" }}>
                  {" "}— these represent the highest priority pipeline failures
                </span>
              </div>
            )}

            {/* Signal rows */}
            {sortedByEV.map((miss, idx) => {
              const tierColors = tierBadgeColor(miss.expectedQualityTier);
              return (
                <div
                  key={`${miss.instrument}-${miss.missedAt}-${idx}`}
                  className="rounded-lg border p-3 space-y-2"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                >
                  {/* Header row */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] font-semibold" style={{ color: "var(--color-fg)" }}>
                        {miss.instrument}
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          color: tierColors.text,
                          background: tierColors.bg,
                        }}
                      >
                        {miss.expectedQualityTier.replace("_", "+")}
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          color: miss.direction === "LONG" ? "var(--color-bull)" : "var(--color-bear)",
                          background: miss.direction === "LONG"
                            ? "color-mix(in oklch, var(--color-bull) 12%, transparent)"
                            : "color-mix(in oklch, var(--color-bear) 12%, transparent)",
                        }}
                      >
                        {miss.direction}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span style={{ color: "var(--color-fg-muted)" }}>EV:</span>
                      <span className="font-mono font-semibold" style={{ color: "var(--color-fg)" }}>
                        {miss.expectedEV >= 0 ? "+" : ""}{miss.expectedEV.toFixed(3)}%
                      </span>
                      <span style={{ color: "var(--color-fg-muted)" }}>Outcome:</span>
                      <span className="font-mono font-semibold" style={{ color: outcomeColor(miss.actualOutcome) }}>
                        {miss.actualOutcome === "WIN" && miss.actualPnlPct != null
                          ? `WIN +${miss.actualPnlPct.toFixed(2)}%`
                          : miss.actualOutcome}
                      </span>
                    </div>
                  </div>

                  {/* Failure layer */}
                  <div className="flex items-start gap-2 text-[11px]">
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        color: layerColor(miss.failureLayer),
                        background: `color-mix(in oklch, ${layerColor(miss.failureLayer)} 12%, transparent)`,
                      }}
                    >
                      {FAILURE_LAYER_LABELS[miss.failureLayer]}
                    </span>
                    <span style={{ color: "var(--color-fg-muted)" }}>{miss.failureReason}</span>
                  </div>

                  {/* Fix required */}
                  <div className="flex items-start gap-1 text-[10px]" style={{ color: "var(--color-fg-subtle)" }}>
                    <span className="shrink-0 font-medium">Fix:</span>
                    <span>{miss.fixRequired}</span>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </CardContent>
    </Card>
  );
}
