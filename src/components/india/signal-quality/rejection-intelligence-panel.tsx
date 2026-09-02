"use client";

/**
 * Rejection Intelligence Panel
 *
 * Shows the top rejection reasons from the opportunity pipeline,
 * distinguishing between correct rejections (avoided losses) and
 * false rejections (missed profitable opportunities).
 *
 * Phase 29–30 of the 64-phase production truth validation:
 *   - Risk Gate Falsification
 *   - Counterfactual Risk Analysis
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface RejectionSummary {
  /** Rejection reason code */
  code: string;
  /** Human-readable label */
  label: string;
  /** Number of signals rejected for this reason */
  count: number;
  /** Estimated losses avoided (count where rejected signal later lost) */
  lossesAvoided: number;
  /** Estimated profits missed (count where rejected signal later won) */
  profitsMissed: number;
  /** Net value: positive = beneficial gate, negative = over-restrictive */
  netValue: number;
  /** Classification of this gate's overall effect */
  verdict: "BENEFICIAL" | "OVER_RESTRICTIVE" | "NEUTRAL" | "INSUFFICIENT_DATA";
}

interface Props {
  rejections: RejectionSummary[];
  /** Total candidates evaluated this session */
  totalCandidates: number;
  /** Total rejected */
  totalRejected: number;
}

function verdictColor(v: RejectionSummary["verdict"]) {
  if (v === "BENEFICIAL") return "var(--color-bull)";
  if (v === "OVER_RESTRICTIVE") return "var(--color-bear)";
  if (v === "NEUTRAL") return "var(--color-fg-muted)";
  return "var(--color-warning)";
}

function verdictLabel(v: RejectionSummary["verdict"]) {
  if (v === "BENEFICIAL") return "Beneficial ✓";
  if (v === "OVER_RESTRICTIVE") return "Over-restrictive ⚠";
  if (v === "NEUTRAL") return "Neutral";
  return "Insufficient data";
}

function pct(n: number, total: number) {
  if (total === 0) return "—";
  return `${((n / total) * 100).toFixed(0)}%`;
}

export function RejectionIntelligencePanel({ rejections, totalCandidates, totalRejected }: Props) {
  const acceptanceRate = totalCandidates > 0
    ? ((totalCandidates - totalRejected) / totalCandidates) * 100
    : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">
              Rejection Intelligence
            </CardTitle>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              Which gates correctly rejected bad trades vs. missed good ones?
            </p>
          </div>
          <div className="text-right text-[11px]">
            <div className="font-mono font-semibold" style={{ color: "var(--color-fg)" }}>
              {totalRejected} rejected
            </div>
            <div style={{ color: "var(--color-fg-muted)" }}>
              {acceptanceRate.toFixed(0)}% acceptance rate
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rejections.length === 0 ? (
          <div className="py-6 text-center text-[12px]" style={{ color: "var(--color-fg-muted)" }}>
            <p className="font-medium">No rejection data available</p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              Rejection intelligence requires SignalLifecycleEvent DB writes (AUDIT-001).
              Deploy the AUDIT-001 fix and allow one session to accumulate data.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Header row */}
            <div className="grid grid-cols-12 gap-1 text-[10px] font-medium uppercase tracking-wider"
              style={{ color: "var(--color-fg-muted)" }}>
              <div className="col-span-4">Rejection Reason</div>
              <div className="col-span-1 text-right">Count</div>
              <div className="col-span-1 text-right">Rate</div>
              <div className="col-span-2 text-right">Losses Avoided</div>
              <div className="col-span-2 text-right">Profits Missed</div>
              <div className="col-span-2 text-right">Verdict</div>
            </div>

            {rejections.map((r) => (
              <div
                key={r.code}
                className="grid grid-cols-12 gap-1 items-center text-[11px] rounded-md px-2 py-1.5"
                style={{ background: "var(--color-surface)" }}
              >
                <div className="col-span-4 truncate font-medium" style={{ color: "var(--color-fg)" }}>
                  {r.label}
                </div>
                <div className="col-span-1 text-right font-mono" style={{ color: "var(--color-fg)" }}>
                  {r.count}
                </div>
                <div className="col-span-1 text-right font-mono" style={{ color: "var(--color-fg-muted)" }}>
                  {pct(r.count, totalCandidates)}
                </div>
                <div className="col-span-2 text-right font-mono" style={{ color: "var(--color-bull)" }}>
                  {r.lossesAvoided > 0 ? `+${r.lossesAvoided}` : "—"}
                </div>
                <div className="col-span-2 text-right font-mono" style={{ color: r.profitsMissed > 0 ? "var(--color-bear)" : "var(--color-fg-muted)" }}>
                  {r.profitsMissed > 0 ? `-${r.profitsMissed}` : "—"}
                </div>
                <div className="col-span-2 text-right">
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      color: verdictColor(r.verdict),
                      background: `color-mix(in oklch, ${verdictColor(r.verdict)} 12%, transparent)`,
                    }}
                  >
                    {verdictLabel(r.verdict)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Summary callout */}
        <div
          className="mt-4 rounded-md border px-3 py-2 text-[11px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface)",
            color: "var(--color-fg-muted)",
          }}
        >
          <strong style={{ color: "var(--color-fg)" }}>What this measures:</strong> For each gate,
          the counterfactual asks — if we had removed this gate, what would have happened?
          A{" "}
          <span style={{ color: "var(--color-bull)" }}>Beneficial</span> gate avoided more losses
          than profits it missed. An{" "}
          <span style={{ color: "var(--color-bear)" }}>Over-restrictive</span> gate is blocking
          too many profitable signals and should be reviewed (not automatically loosened — OOS
          validation required).
        </div>
      </CardContent>
    </Card>
  );
}
