# ALPHAFORGE SIGNAL QUALITY VALIDATION

**Date:** 2026-09-09.

## Status: quality model = SHADOW (not production-authoritative)

The predictive-quality engine implements the full component set and is deterministic +
unit-tested, but its production weights are still an untrained uniform prior. Per the
remediation rule, an `UNTRAINED_UNIFORM_PRIOR` quality basis is **not allowed to drive
live A+**; under the model-state gate it is SHADOW at best.

## Empirical monotonicity (Phase 16)

**NOT MEASURABLE.** Quality→realized-expectancy monotonicity requires resolved trades
tagged with the quality score at signal time. The only real dataset has **0/321**
trades with a persisted `qualityScore`.

| Quality bucket | 40–50 | 50–60 | 60–70 | 70–80 | 80–90 | 90–100 |
|---|---|---|---|---|---|---|
| sample / winRate / expectancy / PF / netPnl / maxDD | — | — | — | — | — | — |

All cells: **INSUFFICIENT EVIDENCE**.

## Rule enforcement

Quality weights must be trained on persisted OOS prediction/outcome pairs (now durable
via `PrismaSignalRecordStore`), then monotonicity validated. If monotonicity is not
demonstrated, the quality model **stays SHADOW** — it is never forced monotonic via
arbitrary score transforms.

**Quality trained? NO · OOS validated? NO · Monotonic? INSUFFICIENT EVIDENCE → SHADOW.**
