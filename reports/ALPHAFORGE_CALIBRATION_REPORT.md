# ALPHAFORGE CALIBRATION REPORT

**Date:** 2026-09-09.

## Machinery (implemented, unit-tested)

`ml-meta-training.ts` implements hierarchical calibrators (isotonic / Platt / raw)
selected by **OOS log-loss** (never test-set), per-model ROC-AUC / log-loss
contribution, PSI drift, and `computeCalibrationMetrics` → Brier / ECE / calibration
slope / intercept. Confidence, probability, quality, ranking and EV are **separate
typed fields** and are not interchanged.

## Runtime calibration status

🔴 **The deployed meta-artifact is UNTRAINED** (`defaultMetaArtifact`: every calibrator
`method:"raw"`, `globalPrior:0.5`, `addsValue:false`). By design it self-reports low
quality and cannot masquerade as calibrated — and under the new model-state gate an
untrained model cannot drive a live A+. So the deployed probability is **not
calibrated**.

## Empirical calibration (Phase 14/17)

**NOT MEASURABLE.** Calibration requires persisted predicted-probability ↔ realized-
outcome pairs. The real ledger has **0/321** trades with a stored predicted
probability. Therefore:

| Metric | Value |
|---|---|
| Brier | NOT MEASURABLE |
| Log loss | NOT MEASURABLE |
| ECE | NOT MEASURABLE |
| Calibration slope / intercept | NOT MEASURABLE |
| Reliability curve (buckets 50–55 … 90+) | NOT MEASURABLE |

"Does 70% predicted mean ~70% realized?" → **INSUFFICIENT EVIDENCE.**

## Verdict

Calibration machinery: real and rigorous. Runtime calibration: **absent (untrained)**.
Empirical calibration: **INSUFFICIENT EVIDENCE** until predicted probabilities are
persisted per trade (unblocked by the new `IndiaPredictionRecord`) and a real OOS
sample accrues.
