"use client";

/**
 * Live Opportunity Funnel
 *
 * Shows the complete opportunity pipeline funnel from detection to
 * profitable outcome. This is the primary production-day validation panel
 * answering: "Is the signal → paper → profit chain working end-to-end?"
 *
 * Phase 57 of the 64-phase production truth validation:
 *   LIVE OPPORTUNITY FUNNEL
 *     Detected → Qualified → Approved → Risk Approved → Paper Captured
 *     → Filled → Open → Closed
 *
 * Also shows the signal quality breakdown (A+/A/B/C/Rejected)
 * and the paper capture rate for high-value signals.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface OpportunityFunnelStage {
  stage:
    | "DETECTED"
    | "QUALIFIED"
    | "RISK_APPROVED"
    | "PAPER_CAPTURED"
    | "FILLED"
    | "CLOSED_WIN"
    | "CLOSED_LOSS"
    | "CLOSED_EXPIRED";
  count: number;
  /** Pass-through rate from the previous stage (0–1) */
  passRate: number | null;
  /** Human-readable label */
  label: string;
}

export interface SignalQualityBreakdown {
  aPlus: number;
  a: number;
  b: number;
  c: number;
  rejected: number;
}

export interface LiveOpportunityFunnelData {
  sessionDate: string;
  stages: OpportunityFunnelStage[];
  qualityBreakdown: SignalQualityBreakdown;
  highValueCaptureRate: number | null;
  highValueTotal: number;
  highValueCaptured: number;
  /** Whether data is live/fresh or estimated */
  dataSource: "LIVE" | "ESTIMATED" | "AUDIT_PENDING";
}

interface Props {
  data: LiveOpportunityFunnelData;
}

const STAGE_ORDER: OpportunityFunnelStage["stage"][] = [
  "DETECTED", "QUALIFIED", "RISK_APPROVED", "PAPER_CAPTURED", "FILLED", "CLOSED_WIN",
];

function stageColor(stage: OpportunityFunnelStage["stage"]) {
  if (stage === "CLOSED_WIN") return "var(--color-bull)";
  if (stage === "CLOSED_LOSS") return "var(--color-bear)";
  if (stage === "CLOSED_EXPIRED") return "var(--color-fg-muted)";
  return "var(--color-brand)";
}

function passRateColor(rate: number | null) {
  if (rate === null) return "var(--color-fg-muted)";
  if (rate >= 0.8) return "var(--color-bull)";
  if (rate >= 0.5) return "var(--color-warning)";
  return "var(--color-bear)";
}

export function LiveOpportunityFunnel({ data }: Props) {
  const { stages, qualityBreakdown, highValueCaptureRate, highValueTotal, highValueCaptured, sessionDate, dataSource } = data;
  const maxCount = Math.max(...stages.map(s => s.count), 1);
  const total = stages.find(s => s.stage === "DETECTED")?.count ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">
              Live Opportunity Funnel
            </CardTitle>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-fg-subtle)" }}>
              {sessionDate} — Signal detection → risk approval → paper capture → outcome
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dataSource === "AUDIT_PENDING" && (
              <span
                className="rounded px-2 py-1 text-[10px] font-medium"
                style={{
                  background: "color-mix(in oklch, var(--color-warning) 15%, transparent)",
                  color: "var(--color-warning)",
                }}
              >
                AUDIT-001: Lifecycle events not yet persisted
              </span>
            )}
            {dataSource === "ESTIMATED" && (
              <span
                className="rounded px-2 py-1 text-[10px] font-medium"
                style={{
                  background: "color-mix(in oklch, var(--color-brand) 15%, transparent)",
                  color: "var(--color-brand)",
                }}
              >
                Estimated
              </span>
            )}
            {dataSource === "LIVE" && (
              <span
                className="rounded px-2 py-1 text-[10px] font-medium"
                style={{
                  background: "color-mix(in oklch, var(--color-bull) 15%, transparent)",
                  color: "var(--color-bull)",
                }}
              >
                Live ●
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Funnel bars */}
        <div className="space-y-2">
          {stages.filter(s => s.count > 0 || s.stage === "DETECTED").map((stage, i) => {
            const widthPct = total > 0 ? Math.round((stage.count / total) * 100) : 0;
            const color = stageColor(stage.stage);
            return (
              <div key={stage.stage} className="space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span style={{ color: "var(--color-fg-muted)" }}>{stage.label}</span>
                  <div className="flex items-center gap-3 font-mono">
                    <span style={{ color: "var(--color-fg)" }}>{stage.count.toLocaleString()}</span>
                    {stage.passRate !== null && (
                      <span style={{ color: passRateColor(stage.passRate) }}>
                        ({(stage.passRate * 100).toFixed(0)}% pass)
                      </span>
                    )}
                    <span style={{ color: "var(--color-fg-subtle)" }}>
                      {total > 0 ? `${widthPct}%` : "—"}
                    </span>
                  </div>
                </div>
                <div
                  className="relative h-5 rounded overflow-hidden"
                  style={{ background: "var(--color-surface)" }}
                >
                  <div
                    className="h-full rounded transition-all duration-500"
                    style={{
                      width: `${widthPct}%`,
                      background: `color-mix(in oklch, ${color} 25%, transparent)`,
                      border: `1px solid color-mix(in oklch, ${color} 45%, transparent)`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* High-value capture rate */}
        <div
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[12px] font-semibold" style={{ color: "var(--color-fg)" }}>
                High-Value Signal Capture Rate
              </p>
              <p className="text-[11px]" style={{ color: "var(--color-fg-muted)" }}>
                A+/A quality signals actually reaching paper trading
              </p>
            </div>
            <div className="text-right">
              <div
                className="text-xl font-bold font-mono"
                style={{
                  color: highValueCaptureRate === null
                    ? "var(--color-fg-muted)"
                    : highValueCaptureRate >= 0.85
                    ? "var(--color-bull)"
                    : highValueCaptureRate >= 0.6
                    ? "var(--color-warning)"
                    : "var(--color-bear)",
                }}
              >
                {highValueCaptureRate === null
                  ? "—"
                  : `${(highValueCaptureRate * 100).toFixed(1)}%`}
              </div>
              <div className="text-[10px]" style={{ color: "var(--color-fg-subtle)" }}>
                {highValueCaptured} / {highValueTotal} captured
              </div>
            </div>
          </div>
        </div>

        {/* Quality breakdown */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--color-fg-muted)" }}>
            Signal Quality Distribution
          </p>
          <div className="grid grid-cols-5 gap-1">
            {[
              { label: "A+", value: qualityBreakdown.aPlus, color: "var(--color-bull)" },
              { label: "A", value: qualityBreakdown.a, color: "var(--color-brand)" },
              { label: "B", value: qualityBreakdown.b, color: "var(--color-warning)" },
              { label: "C", value: qualityBreakdown.c, color: "var(--color-fg-muted)" },
              { label: "Rej", value: qualityBreakdown.rejected, color: "var(--color-bear)" },
            ].map((tier) => (
              <div
                key={tier.label}
                className="rounded-md p-2 text-center"
                style={{ background: "var(--color-surface)" }}
              >
                <div
                  className="text-[10px] font-semibold"
                  style={{ color: tier.color }}
                >
                  {tier.label}
                </div>
                <div
                  className="mt-1 text-[14px] font-bold font-mono"
                  style={{ color: "var(--color-fg)" }}
                >
                  {tier.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
