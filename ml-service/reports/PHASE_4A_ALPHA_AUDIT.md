# PHASE 4A — Alpha Audit

**Repository:** alpha-forge · **Branch:** `refactor/improve-ml-service` · **HEAD:** `705b881`
**Date:** 2026-09-06 · **Audit type:** AUDIT-ONLY (no recalibration, no threshold tuning, no optimization)

This audit assesses alpha **based only on real-market evidence** (§45). Because zero real sessions exist, every alpha metric below is undefined for lack of observations. No alpha metric was computed from synthetic or test data and presented as real.

---

## Sample size

| Dimension | Count |
| --- | --- |
| Real trading sessions | 0 |
| Real trades | 0 |
| Independent signal events | 0 |
| Instruments observed | 0 |
| Regimes observed | 0 |
| Winners / losers | 0 / 0 |

n = 0 for every statistic. No metric can be estimated; none is claimed.

## Performance (independent recomputation)

| Metric | Value | Note |
| --- | --- | --- |
| Gross return | — | no real trades |
| Net return | — | no real trades |
| Sharpe / Sortino / Calmar | — | undefined (n=0) |
| Max drawdown | — | undefined |
| Hit rate | — | undefined |
| Avg win / avg loss / expectancy | — | undefined |
| Profit factor | — | undefined |
| Turnover / costs / slippage | — | no real trades |

## Predictive evidence

| Metric | Value | Note |
| --- | --- | --- |
| IC / Rank IC / ICIR | — | no real observations |
| Decile returns / monotonicity / top-bottom spread | — | no real observations |
| Calibration (Brier / ECE / MCE) | — | CALIBRATION_INSUFFICIENT_EVIDENCE |
| EV bucket vs realized | — | no real trades |
| Probability bucket vs observed frequency | — | no real trades |

Note: the underlying computations are certified and independently recalculated on synthetic/deterministic inputs in Phase 3T (EV matches `P·win+(1-P)·loss-cost` to 1e-6; Rank IC matches `scipy.stats.spearmanr`). Those verify the *machinery*, not real alpha.

## Attribution / conditional analysis

Alpha attribution (beta/sector/factor/selection/timing/execution/costs), regime, sector, liquidity, market-cap, long/short, time-of-day, and F&O breakdowns are all **undefined** — zero real observations to decompose or condition on.

## Statistical uncertainty

Undefined (n=0). No confidence intervals, bootstrap intervals, or significance claims. `INSUFFICIENT_SAMPLE` everywhere.

## Multiple-testing / sequential-peeking exposure

**Zero.** No analyses were run on real data, so there is no multiple-testing exposure, no subgroup search, no sequential-peeking risk, and no false-discovery risk to adjust for.

## Overfitting classification

**CLEAN.** Independent git-history review confirms the ML service source was frozen at `abbc403` (PHASE_3S): neither the 3T nor 4A commits changed any `src/` file. There is no threshold tuning, feature selection, model selection, benchmark selection, or cost-assumption change after any observation — because no observation occurred and no source changed.

## Alpha classification (§45)

**`INSUFFICIENT_EVIDENCE`.**

- Not `NO_ALPHA`: absence of evidence is not evidence of absence — no real trades were observed to contradict the hypothesis.
- Not `WEAK/PROMISING/VALIDATED_ALPHA`: those require positive real observations, of which there are none.
- Not `INVALIDATED`: no evidence contradicts the hypothesis either.

The scientifically correct statement is that AlphaForge's real-market alpha is **untested**, and the evidence needed to test it has not been collected.
