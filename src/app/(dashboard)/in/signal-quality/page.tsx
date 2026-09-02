/**
 * /in/signal-quality — Quant Signal Quality Dashboard
 *
 * 20-phase scientific signal quality evaluation for AlphaForge Indian market strategies.
 * This page evaluates SIGNAL VALUE, not just system correctness.
 *
 * Phases covered:
 *   1  Ground truth definitions (strategy-specific horizons)
 *   2  Confusion matrices (TP/FP/FN/TN, Precision/Recall/F1)
 *   3  Signal capture recall
 *   4  Signal precision (raw, cost-adjusted, risk-adjusted)
 *   5  Forward return analysis
 *   6  MFE / MAE analysis
 *   7  Confidence calibration (Brier, ECE, reliability diagram)
 *   8  Win probability validation
 *   9  Grade validation (S/A/B/C/D ordering)
 *  10  Strategy leaderboard (sample-size aware)
 *  11  Filter ablation
 *  12  ML incremental value
 *  13  Signal correlation
 *  14  Market regime quality
 *  15  Instrument quality
 *  16  Time-of-day quality
 *  17  Paper vs signal funnel
 *  18  Cost robustness (Base / 1.5× / 2× / 3×)
 *  19  Statistical significance
 *  20  Signal Quality Score (0–100)
 */

import { Suspense } from "react";
import { computeSignalQualityReport } from "@/lib/signal-quality/engine";
import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { HeadlineMetrics } from "@/components/india/signal-quality/headline-metrics";
import { StrategyLeaderboard } from "@/components/india/signal-quality/strategy-leaderboard";
import { ConfusionMatrixCard } from "@/components/india/signal-quality/confusion-matrix-card";
import { ConfidenceCalibrationChart, WinProbabilityCalibrationCard } from "@/components/india/signal-quality/calibration-chart";
import { RegimeHeatmap } from "@/components/india/signal-quality/regime-heatmap";
import { TimeOfDayHeatmap } from "@/components/india/signal-quality/time-of-day-heatmap";
import { MfeMaeTable } from "@/components/india/signal-quality/mfe-mae-card";
import { GradeValidationCard } from "@/components/india/signal-quality/grade-validation-card";
import { PaperSignalFunnelCard } from "@/components/india/signal-quality/paper-signal-funnel";
import { SignalQualityScoreCard } from "@/components/india/signal-quality/signal-quality-score-card";
import { CostRobustnessCard } from "@/components/india/signal-quality/cost-robustness-card";
import { InstrumentHeatmap } from "@/components/india/signal-quality/instrument-heatmap";
import { FinalVerdictsPanel } from "@/components/india/signal-quality/final-verdicts-panel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Signal Quality · NSE F&O",
  description:
    "Scientific 20-phase signal quality evaluation: precision, recall, confidence calibration, MFE/MAE, market regime analysis, time-of-day quality, cost robustness, and ML contribution for every AlphaForge Indian market strategy.",
};

async function SignalQualityContent() {
  const report = await computeSignalQualityReport(30);

  // Aggregate calibration (ALL)
  const allCalib = report.confidenceCalibration.find((c) => c.strategyId === "ALL");
  const pickCalib = report.confidenceCalibration.find((c) => c.strategyId === "DAILY_PICK_AI");
  const allWinProb = report.winProbabilityCalibration.find((c) => c.strategyId === "ALL");
  const pickWinProb = report.winProbabilityCalibration.find((c) => c.strategyId === "DAILY_PICK");

  // Only show non-trivial confusion matrices (n ≥ 1)
  const significantMatrices = report.confusionMatrices.filter((m) => m.sampleSize >= 1);

  // Strategies with resolved trades for funnel/cost display
  const activeStrategies = report.finalVerdicts.filter((v) => v.sampleSize > 0);

  return (
    <div className="space-y-8">
      {/* ── Headline metrics ─────────────────────────────────────────────── */}
      <section>
        <HeadlineMetrics report={report} />
      </section>

      {/* ── Final Verdicts (most important: always first) ─────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Final Verdicts — Which Strategies Have Measurable Trading Value?
        </h2>
        <FinalVerdictsPanel verdicts={report.finalVerdicts} />
      </section>

      {/* ── Strategy Leaderboard ──────────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Strategy Leaderboard
        </h2>
        <StrategyLeaderboard entries={report.leaderboard} />
      </section>

      {/* ── Signal Quality Scores ─────────────────────────────────────────── */}
      {report.signalQualityScores.length > 0 && (
        <section>
          <h2
            className="mb-3 text-base font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            Signal Quality Score Breakdown (0–100)
          </h2>
          <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            Weighted composite: Precision ×20, Expectancy ×20, Drawdown ×10, Recall ×10,
            Cost Robustness ×10, Calibration ×10, Regime Consistency ×10, Sample Size ×5, Paper Execution ×5.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {report.signalQualityScores.slice(0, 9).map((qs) => (
              <SignalQualityScoreCard key={qs.strategyId} scoreData={qs} />
            ))}
          </div>
        </section>
      )}

      {/* ── Confusion Matrices ────────────────────────────────────────────── */}
      {significantMatrices.length > 0 && (
        <section>
          <h2
            className="mb-3 text-base font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            Signal Confusion Matrices
          </h2>
          <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            TP = signal fired → profitable. FP = signal fired → loss. FN = opportunity missed.
            Conservative tie-break: stop always wins when both target and stop hit in the same candle.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {significantMatrices.map((m) => (
              <ConfusionMatrixCard key={m.strategyId} matrix={m} />
            ))}
          </div>
        </section>
      )}

      {/* ── Confidence Calibration ────────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Confidence Calibration
        </h2>
        <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
          If predicted confidence = 80% but actual win rate = 52%, confidence is poorly calibrated.
          ECE &lt; 0.05 = well-calibrated. Brier Score: lower is better (0 = perfect, 1 = worst).
        </p>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {allCalib && <ConfidenceCalibrationChart calibration={allCalib} />}
          {pickCalib && <ConfidenceCalibrationChart calibration={pickCalib} />}
        </div>
      </section>

      {/* ── Win Probability Calibration ───────────────────────────────────── */}
      {(allWinProb || pickWinProb) && (
        <section>
          <h2
            className="mb-3 text-base font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            Win Probability Calibration
          </h2>
          <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            If a signal predicts 70% win probability, over enough observations the realised win rate
            should approach 70%. INSUFFICIENT_SAMPLE = n &lt; 10; not a calibration failure.
          </p>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {allWinProb && <WinProbabilityCalibrationCard calibration={allWinProb} />}
            {pickWinProb && <WinProbabilityCalibrationCard calibration={pickWinProb} />}
          </div>
        </section>
      )}

      {/* ── Grade Validation ──────────────────────────────────────────────── */}
      {report.gradeValidation.length > 0 && (
        <section>
          <h2
            className="mb-3 text-base font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            Grade Validation (S / A / B / C / D)
          </h2>
          <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            Expected: S ≥ A ≥ B ≥ C ≥ D for expectancy, win rate, and profit factor.
            If ordering is inverted, the grade system adds no value.
          </p>
          <div className="space-y-4">
            {report.gradeValidation.map((gv) => (
              <GradeValidationCard key={gv.strategyId} validation={gv} />
            ))}
          </div>
        </section>
      )}

      {/* ── MFE / MAE ─────────────────────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          MFE / MAE Analysis
        </h2>
        <MfeMaeTable summaries={report.mfeMaeSummaries} />
      </section>

      {/* ── Regime Heatmap ────────────────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Market Regime × Strategy Quality
        </h2>
        <RegimeHeatmap regimeQuality={report.regimeQuality} />
      </section>

      {/* ── Time-of-Day ───────────────────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Time-of-Day Quality (IST)
        </h2>
        <TimeOfDayHeatmap buckets={report.timeOfDayQuality} />
      </section>

      {/* ── Instrument Heatmap ────────────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Instrument Quality
        </h2>
        <InstrumentHeatmap rows={report.instrumentQuality} />
      </section>

      {/* ── Paper vs Signal Funnel ────────────────────────────────────────── */}
      {report.paperSignalFunnel.filter((f) => f.stages.some((s) => s.count > 0)).length > 0 && (
        <section>
          <h2
            className="mb-3 text-base font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            Paper Trading vs Signal Funnel
          </h2>
          <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            Where is edge lost? Signal Generated → Risk Approved → Paper Executed → Profitable Outcome.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {report.paperSignalFunnel
              .filter((f) => f.stages.some((s) => s.count > 0))
              .slice(0, 6)
              .map((f) => (
                <PaperSignalFunnelCard key={f.strategyId} funnel={f} />
              ))}
          </div>
        </section>
      )}

      {/* ── Cost Robustness ───────────────────────────────────────────────── */}
      {activeStrategies.length > 0 && (
        <section>
          <h2
            className="mb-3 text-base font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            Cost Robustness (Base → 3× Cost)
          </h2>
          <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
            COST_ROBUST = precision unchanged at 2× cost. COST_FRAGILE = edge collapses under realistic transaction costs.
            Base cost: 5 bps round-trip (NSE F&O standard).
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {report.costRobustness
              .filter((cr) => cr.rows[0].precision > 0)
              .slice(0, 6)
              .map((cr) => (
                <CostRobustnessCard key={cr.strategyId} robustness={cr} />
              ))}
          </div>
        </section>
      )}

      {/* ── Ground Truth Definitions ──────────────────────────────────────── */}
      <section>
        <h2
          className="mb-3 text-base font-semibold"
          style={{ color: "var(--color-fg)" }}
        >
          Ground Truth Definitions
        </h2>
        <p className="mb-4 text-[12px]" style={{ color: "var(--color-fg-subtle)" }}>
          Evaluation rules were defined BEFORE any outcome was computed.
          Strategy-specific horizons — no single EOD rule applied universally.
          Conservative tie-break: stop always wins when both levels hit in the same candle.
        </p>
        <div
          className="overflow-x-auto rounded-xl border text-[11px]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <table className="w-full">
            <thead>
              <tr
                className="border-b text-[10px] uppercase tracking-widest"
                style={{ borderColor: "var(--color-border)", color: "var(--color-fg-subtle)", background: "var(--color-surface)" }}
              >
                <th className="px-4 py-2 text-left">Strategy</th>
                <th className="px-4 py-2 text-left">Evaluation Horizon</th>
                <th className="px-4 py-2 text-left">Success</th>
                <th className="px-4 py-2 text-left">Neutral</th>
                <th className="px-4 py-2 text-left">Valid Opportunity Condition</th>
              </tr>
            </thead>
            <tbody>
              {report.finalVerdicts.map((v) => {
                // Find ground truth def from our static list
                return (
                  <tr
                    key={v.strategyId}
                    className="border-b"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <td className="px-4 py-2 font-medium" style={{ color: "var(--color-fg)" }}>
                      {v.label}
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--color-info)" }}>
                      Strategy-specific
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--color-bull)" }}>
                      Target before Stop
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--color-fg-muted)" }}>
                      Time Exit
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--color-fg-subtle)" }}>
                      See methodology docs
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Report metadata ───────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between rounded-xl border px-4 py-3 text-[11px]"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <span style={{ color: "var(--color-fg-subtle)" }}>
          Report generated:{" "}
          <span style={{ color: "var(--color-fg-muted)" }}>
            {new Date(report.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST
          </span>
        </span>
        <span style={{ color: "var(--color-fg-subtle)" }}>
          Window: {report.evaluationWindowDays} days ·{" "}
          {report.totalTradesEvaluated} trades · {report.totalSignalsEvaluated} signals
        </span>
        <a
          href="/docs/INDIAN_MARKET_SIGNAL_QUALITY_BENCHMARK.md"
          className="underline-offset-2 hover:underline"
          style={{ color: "var(--color-brand)" }}
        >
          Full Benchmark Report →
        </a>
      </div>
    </div>
  );
}

function SignalQualitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[80px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[200px] rounded-xl" />
      <Skeleton className="h-[400px] rounded-xl" />
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[260px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function SignalQualityPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <PageTransition>
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <PageHeader
          title="Signal Quality · NSE F&O"
          subtitle="Scientific 20-phase evaluation: precision, recall, confidence calibration, MFE/MAE, regime analysis, and ML contribution. The software running ≠ the signals having value."
        />

        <IndiaBestTimeBanner initial={bestTimeInitial} />

        <Suspense fallback={<SignalQualitySkeleton />}>
          <SignalQualityContent />
        </Suspense>
      </div>
    </PageTransition>
  );
}
