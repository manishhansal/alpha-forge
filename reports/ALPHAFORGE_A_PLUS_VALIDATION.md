# ALPHAFORGE A+ VALIDATION

**Date:** 2026-09-09.

> ## A+ superiority: **INSUFFICIENT EVIDENCE** (cannot be certified)

## Real-outcome evidence

No resolved trade in the only real dataset (`today-signal-ledger`, 321 trades) carries
a grade — `grade` is present in **0/321** trades. Every A+-vs-A-vs-B comparison
(win rate, expectancy, PF, avg/median R, net P&L, cost-adjusted P&L, 2× cost EV,
robustness, drawdown, calibration) is therefore **NOT MEASURABLE FROM REAL DATA**, and
the A+ factory has **no runtime caller**, so no A+ grade has ever been assigned to a
real trade.

| A+ property | Result |
|---|---|
| A+ count / win rate / expectancy / PF (real) | NOT MEASURABLE |
| A+ vs A vs B incremental value (real) | NOT MEASURABLE |
| Cost-adjusted profitable (real) | INSUFFICIENT EVIDENCE |
| Robust under 2× costs (real) | INSUFFICIENT EVIDENCE |
| Sufficient sample size | NO (n = 0 real A+) |

## Unit-level (synthetic) evidence only

The A+ factory (`a-plus-signal-factory.ts`) is internally correct: 14-stage pipeline,
13-condition evidence gate (no quota), geometric-mean correlation dedup (duplicates
cannot inflate), OpportunityScore that zeroes on negative EV, complete evidence card;
A+>A>B holds on a **synthetic** harness (14 tests). These are simulation results, not
market results.

## Safety rails added by this remediation

- **No A+ with net EV ≤ 0** — guarded (`remediation-regression-guards.test.ts`).
- **Untrained/shadow model cannot mint a live A+ → ABSTAIN** — enforced by
  `model-state-gate.ts` and guarded.

## Verdict

A+ statistically validated? **NO.** Cost-adjusted profitable? **INSUFFICIENT
EVIDENCE.** Robust under 2× costs (real)? **INSUFFICIENT EVIDENCE.** Sufficient sample?
**NO.** No A+ result was manufactured.
