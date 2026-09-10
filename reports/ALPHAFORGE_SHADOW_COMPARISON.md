# ALPHAFORGE SHADOW COMPARISON

**Date:** 2026-09-09.

## Purpose

Compare `legacyDecision` vs `newDecision` (the canonical decision from the shadow
pipeline) so the new stack can be evaluated **without** risking execution.

## Current status: scaffolding in place, NO shadow sample yet

The shadow pipeline (`evaluateShadow`) produces a `CanonicalDecisionResult` and can
persist an immutable prediction record. The comparison harness requires the pipeline to
be invoked from the live builder (the remaining P0 hook) so that, for each live signal,
both the legacy decision and the new decision are recorded side by side.

| Metric | Legacy | New (shadow) |
|---|---|---|
| signal count / trade count | — | — |
| A+ / A / B count | — | — |
| abstention rate | — | — |
| win rate / expectancy / PF / net P&L / max DD | — | — |

All cells: **INSUFFICIENT EVIDENCE** (no shadow sample accrued).

## Discipline

- The new decision **must not** replace the legacy decision automatically.
- SHADOW mode runs until a sufficient sample exists and the new stack demonstrably
  matches-or-beats legacy on cost-adjusted expectancy + calibration on **real** data.
- Only then may mode advance to PAPER (Phase 23), still with no live trading.

## Verdict

Shadow comparison is **structurally ready** (mode + canonical decision + persistence)
but has **no data**. New-vs-legacy improvement: **INSUFFICIENT EVIDENCE**.
