# ALPHAFORGE CALIBRATION VALIDATION

**Date:** 2026-09-09.

## Machinery

`ml-meta-training.ts` selects Platt/isotonic/beta by **OOS log-loss** (never test set),
with hierarchical fallback (strategy+regime+timeframe → strategy+regime → strategy →
global) and `computeCalibrationMetrics` (Brier/ECE/slope/intercept). Confidence,
probability, quality, ranking and EV are separate typed fields. All unit-tested.

## Empirical calibration

**NOT MEASURABLE / CALIBRATION_UNAVAILABLE.** No persisted predicted-probability ↔
realized-outcome pairs exist (the one real ledger has 0/321 with a stored probability;
the durable store is now wired but has no accrued data yet).

| Metric | Value |
|---|---|
| Brier / Log loss / ECE / slope / intercept | NOT MEASURABLE |
| Reliability by bucket (50–55 … 90+) | NOT MEASURABLE |
| "70% ⇒ ~70%?" | INSUFFICIENT EVIDENCE |

## Runtime behaviour

The deployed meta artifact is untrained → the canonical authority returns
`CALIBRATION_UNAVAILABLE → WAIT` rather than claiming a calibrated probability. This is
the correct fail-safe: no uncalibrated number is presented as calibrated.

**Status: calibration machinery present; empirical calibration INSUFFICIENT EVIDENCE;
runtime correctly reports CALIBRATION_UNAVAILABLE.**
