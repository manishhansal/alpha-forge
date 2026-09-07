# PHASE 4A — Evidence Certification Report

**Repository:** alpha-forge · **Branch:** `refactor/improve-ml-service` · **Commit:** `4b48088` (PHASE_3T)
**Date:** 2026-09-06 · **Live trading:** DISABLED
**Baseline:** `PAPER_BASELINE_V1` (frozen; see `PHASE_4A_ENTRY_MANIFEST.json`)

---

## Executive summary

Phase 4A set out to collect **real Indian-market paper-trading evidence** from the frozen, certified ML service to determine whether AlphaForge produces genuine, persistent, cost-adjusted, out-of-sample alpha. The entry audit, baseline freeze, and safety verification are complete and green. However, the **real-market evidence window was not executed**: there are no live provider credentials configured and no real NSE/BSE trading days can elapse in this environment. Because Phase 4A requires *real* market observations and explicitly forbids fabricating evidence, **no trading/statistical/predictive/robustness evidence was collected.**

The honest, spec-compliant classification is **`PHASE_4A_INSUFFICIENT_EVIDENCE`** — which §51/§56 name as a valid, scientifically correct outcome. The ML service was not modified; the champion remains frozen; no promotion, retraining, recalibration, or live trading occurred.

This report deliberately separates **engineering evidence** (which is strong) from **alpha evidence** (which is absent) — the distinction Phase 3T established and Phase 4A preserves.

## Baseline identity

`PAPER_BASELINE_V1`: certified 3A–3T champion, frozen. Feature/label/cost/slippage/portfolio/decision versions reference the certified registries; code commit `4b48088`. Concrete model/calibrator artifact hashes are `NOT_ESTABLISHED_NO_REAL_SESSION` because no real session produced them.

---

## §55 Evidence categories

### Engineering evidence — STRONG

| Metric | Result |
| --- | --- |
| System regression (frozen 3A–3T) | 1570 passed / 28 skipped / 0 failed |
| Live-order boundary | Zero primitives in `ml-service/src`; LIVE_TRADING DISABLED |
| Security | Zero hardcoded secrets; zero frontend public secrets |
| Reconciliation machinery | Present & test-covered (Phase 3R) — not exercised on real sessions |
| Replay machinery | Present & test-covered (Phase 3R/3S) — not exercised on real sessions |
| Data-reliability / provider fallback machinery | Present & test-covered (Phase 3Q) — not exercised on real providers |

Engineering machinery is production-grade and fail-closed. It has **not** run against real market sessions in Phase 4A.

### Statistical evidence — NONE

Sample size: **0 real sessions, 0 real trades, 0 independent observations, 0 regimes observed.** No confidence intervals, bootstrap intervals, Sharpe/hit-rate/IC uncertainty can be computed. `INSUFFICIENT_SAMPLE` on every statistic.

### Trading evidence — NONE

No real net return, Sharpe, drawdown, turnover, costs, or capacity were observed. Nothing to report.

### Predictive evidence — NONE

No real IC, Rank IC, calibration (Brier/ECE/MCE), EV validation, or decile monotonicity were observed. The calibration and EV *machinery* are certified (Phase 3F/3T independent recalculation), but no real predicted-vs-realized observations exist.

### Robustness evidence — NONE

No regime / sector / liquidity / market-cap / F&O / long-short breakdowns — zero real observations to condition on.

---

## Sessions completed / invalidated

- Sessions completed: **0**
- Sessions invalidated: **0**
- Reason: evidence window not executed.

## Total trades

**0.**

## Data / provider statistics

No provider calls made (no credentials). Provider chain is configured but non-operational: Data Service → Angel One → Upstox → Yahoo, all credentials unset.

## Operational reliability

Entry: 100% of entry checks passed. No sessions ran, so uptime / session-completion / reconciliation-success / replay-success rates over a real window are **not measured**.

## Net performance / benchmark / costs / slippage / drawdown

Not measured — no real trades.

## IC / Rank IC / calibration / EV / decile / regime / signal-family analysis

Not measured — no real observations. The underlying computations are certified (Phase 3E/3F/3T) and independently recalculated in Phase 3T, but require real data to produce Phase 4A evidence.

## Statistical uncertainty

Undefined (n = 0). No premature significance claimed.

## Multiple-testing exposure

Zero analyses performed on real data — no multiple-testing exposure incurred, no exploratory subgroup searches, no risk of false discovery in this window.

## Reconciliation / replay

Machinery present and test-covered; not exercised on real sessions.

## Security / live-order safety

CLEAN. Zero secrets; zero live-order primitives; LIVE_TRADING DISABLED and enforced at session-start and paper-order boundaries.

## Evidence hashes

No session evidence packages were produced (no sessions), so no per-session hashes exist. The entry manifest and this report are the Phase 4A artifacts; their integrity is tracked by the commit hash `4b48088` + git.

## Known limitations

- No live provider credentials → cannot fetch real Indian-market data.
- No real trading days can elapse in this environment → cannot accumulate a real evidence window.
- Deep-learning / RL runtime unexercised (torch absent); some tests dependency-skipped.
- All prior evidence (3A–3T) is synthetic/historical machinery, not real-market alpha.

---

## §56 Final alpha classification

**`PHASE_4A_INSUFFICIENT_EVIDENCE`**

Rationale: the real-market evidence window was not executed, so there is no real trading/statistical/predictive/robustness evidence on which to base any alpha claim. Per §51/§56, this is a valid and correct outcome — the system is not fooling itself into a premature `VALIDATED_ALPHA`. `NO_ALPHA` is **not** asserted either, because the absence of evidence is not evidence of absence: no real trades were observed to *contradict* the hypothesis.

## §57 Recommendation (no automatic action)

This report only recommends; human review determines the next step. Nothing was promoted, retrained, recalibrated, or enabled.

1. Provision live (read-only) data-provider credentials for Data Service / Angel One / Upstox in a controlled, credential-safe environment (backend/data-service only, never frontend).
2. Run the frozen `PAPER_BASELINE_V1` in PAPER mode across a pre-specified real evidence window (define minimum sessions/trades/regimes in advance, §28).
3. Accumulate immutable daily evidence packages (§13) and run periodic replay/reconciliation checks (§32).
4. At the predefined window boundary, re-run this certification and classify the alpha evidence on real observations.
5. Keep the champion frozen; any change routes through Phase 3S → OOS validation → lifecycle gates → human approval (§40).

**Do not** enable live trading. **Do not** promote or modify any model based on this report.

---

**PHASE_4A_INSUFFICIENT_EVIDENCE**
**LIVE_TRADING_STATUS: DISABLED**
**ML_SERVICE: FROZEN (unchanged)**
