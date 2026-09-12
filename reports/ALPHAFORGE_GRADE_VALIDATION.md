# ALPHAFORGE GRADE VALIDATION

**Date:** 2026-09-09.

## Status: grading = SHADOW (empirical ordering unproven)

The evidence-grading + net-EV-gated grading engines are implemented and unit-tested
(gross EV can never earn A/A+; A+ requires the full multi-criteria gate — not just
quality+EV). The canonical decision authority additionally enforces that A+ can only
TRADE when the backing model is live-eligible and net EV survives 2× cost.

## Empirical monotonicity (Phase 18)

**NOT MEASURABLE.** A+ > A > B > C on realized outcomes requires resolved trades tagged
with their grade at signal time. The only real dataset has **0/321** graded trades, and
the shadow pipeline (which now assigns grades) is not yet accruing persisted outcomes.

| Grade | A+ | A | B | C | REJECT |
|---|---|---|---|---|---|
| count / winRate / expectancy / PF / netPnl / maxDD | — | — | — | — | — |

All cells: **INSUFFICIENT EVIDENCE**. grade×regime / grade×strategy / grade×timeframe:
NOT MEASURABLE (regime not persisted per resolved trade).

## Rule enforcement

Grades are persisted immutably at signal creation via the shadow prediction record.
Once a real OOS sample accrues, validate A+ > A > B > C. If the ordering fails, grading
**stays SHADOW** — thresholds are NOT lowered to force monotonicity or to mint more A+.

**A+ > A > B > C? INSUFFICIENT EVIDENCE → grading SHADOW.**
