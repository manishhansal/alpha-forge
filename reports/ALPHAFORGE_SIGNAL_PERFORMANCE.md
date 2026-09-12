# ALPHAFORGE SIGNAL PERFORMANCE

**Date:** 2026-09-09. Real resolved outcomes only. Rule: profitable only if realized
net expectancy > 0 after costs.

## The only real dataset

`reports/today-signal-ledger-2026-09-01.json` — 321 paper trades, one session,
resolved against live Angel One candles.

| Metric | Value |
|---|---|
| Resolved | 47 WIN / 136 LOSS / 138 EXPIRED |
| Win rate | 25.68% |
| Avg win / avg loss | +0.6296% / −0.4561% (ratio 1.38) |
| Break-even win rate | 42.01% |
| Gross expectancy / trade | **−0.1773%** |
| Total P&L | **−₹32,624** |
| Net expectancy | **NEGATIVE** |

## Segmented performance (A+/A/B/C/REJECT; quality/probability/regime/timeframe buckets)

**NOT MEASURABLE from real data.** The ledger persists no grade, quality,
calibratedProbability, regime, returnR, MFE, or MAE per trade (verified: each present
in 0/321 trades). Only `strategy` and `timeframe` axes exist. Producing the requested
segmented tables requires the durable `IndiaPredictionRecord`/`IndiaResolutionRecord`
persistence (added by this remediation) to be wired into the live path and to accrue a
real multi-session sample.

> Any A+/A/B/C table produced today would be fabricated. It is therefore reported as
> **INSUFFICIENT EVIDENCE**, not filled with numbers.

## Verdict

Signal performance on real evidence is **negative net expectancy → NOT PROFITABLE**.
Grade/quality/regime-segmented performance is **INSUFFICIENT EVIDENCE** pending the
persistence wiring + a real OOS sample.
