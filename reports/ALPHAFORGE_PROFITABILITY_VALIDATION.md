# ALPHAFORGE PROFITABILITY VALIDATION

**Date:** 2026-09-09. Rule: profitable only if realized net expectancy > 0 after costs.

## Real-data measurement (the only measurable test)

`today-signal-ledger-2026-09-01.json` (321 trades, one session):

| Metric | Value |
|---|---|
| Win rate | 25.68% |
| Break-even WR | 42.01% |
| Gross expectancy / trade | −0.1773% |
| Net expectancy | **NEGATIVE** |
| Total P&L | −₹32,624 |
| Profit factor | 0.90 |

**OOS profitability: FAIL** on the only real dataset (this reflects the *legacy* path —
the new SHADOW stack is not yet accruing its own outcomes).

## New-stack profitability

**INSUFFICIENT EVIDENCE.** The shadow pipeline (net-EV-gated grading, 2×/3× cost stress,
counterfactual robustness) is wired and enforces `NEGATIVE_NET_EV → NO_TRADE` and "no
A+ with net EV ≤ 0", but it has generated no persisted resolved outcomes yet, and there
is no multi-session history to replay.

## Segmented performance (quality/probability/strategy/regime/timeframe/instrument/time-of-day)

All **NOT MEASURABLE** — the required per-trade tags are not persisted in the real
dataset. Not aggregated, not estimated.

## Verdict

Net expectancy: **NEGATIVE (real) / INSUFFICIENT EVIDENCE (new stack)** · Profit factor:
0.90 (real) · 2× cost robustness: enforced in code, unproven on real fills ·
**OOS profitability: FAIL / INSUFFICIENT EVIDENCE.** No profitability is claimed.
