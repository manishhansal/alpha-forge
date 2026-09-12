# ALPHAFORGE SIGNAL PROFITABILITY VALIDATION

**Actual profitability evidence.** Read-only. 2026-09-09. Cross-references
`INDIA_SIGNAL_PROFITABILITY_CERTIFICATION.md`. **Rule: profitable only if realized
net expectancy > 0 after realistic costs and slippage.**

---

## 1. THE ONLY REAL DATASET

`reports/today-signal-ledger-2026-09-01.json` — 321 paper trades resolved against
live Angel One candles, P&L reconciliation `VERIFIED_EXACT`, one session. It is the
sole source of realized outcomes. It contains **none** of the fields required for the
grade/quality/probability/regime analyses (verified: grade, quality, calibratedProbability,
regime, netReturn, costActual, MFE, MAE, returnR, modelVersion, independentSignalCount
are each present in **0/321** trades).

---

## 2. NET EXPECTANCY TEST (Phase 11 / 16 / 18 — the measurable one)

| Metric | Value |
|---|---|
| Resolved | 47 WIN / 136 LOSS / 138 EXPIRED |
| Resolved win rate | **25.68%** |
| Avg win / avg loss | +0.6296% / −0.4561% (W/L ratio 1.38) |
| **Break-even win rate** | **42.01%** |
| **Gross expectancy / trade** | **−0.1773%** |
| Total realized P&L | **−₹32,624** |

> **VERDICT: realized net expectancy < 0 → NOT PROFITABLE.** The win rate (25.68%) is
> ~16 points **below** the break-even it must clear (42.01%), *before* the full F&O
> cost stack. Costs only widen the loss. A high win rate is not claimed and would not
> rescue it.

**Statistical significance (Phase 15):** at n=183 resolved (47/136), the win-rate
point estimate is far below break-even; the edge is significantly negative, not noise.
No test can rescue a point estimate this far under threshold. **Effect size:** the gap
to break-even (~16 pts) is large and practically significant.

---

## 3. TESTS THAT ARE NOT MEASURABLE FROM REAL DATA

Per the audit's own rule (evidence over claims), these are reported honestly as
**NOT MEASURABLE / INSUFFICIENT EVIDENCE**, not fabricated:

| Phase | Test | Why not measurable |
|---|---|---|
| 16 | Signal-Quality → profitability (buckets 0–40…90–100; corr/rank-corr with realized R) | `qualityScore` on 0/321 trades |
| 17 | Probability calibration (buckets 50–55…90+; Brier/ECE/slope) | predicted prob on 0/321 trades |
| 18 | Grade profitability A+>A>B>C; grade×regime/strategy/timeframe | grade & regime on 0/321 trades (only strategy+timeframe axes exist) |
| 20 | Signal independence (rawSignalCount vs independentSignalCount) | no `independentSignalCount`; duplicate inflation only inferable structurally |

**Structural duplicate-inflation check (Phase 20, partial):** grouping ledger trades
by (symbol, direction, entry, openedAt) shows the **same opportunity appearing across
timeframes** — an in-file inflation factor of **1.31×** (the project scorecard cites
up to 3× via DUP-001). So confirmation-inflation **is present in the live path**,
even though the (unwired) A+ factory's clustering would prevent it.

---

## 4. WHAT THIS MEANS

- The improved profitability/quality/grade/A+ engines are **not on the path** that
  produced these outcomes (no runtime caller — see system-validation report), so this
  negative result reflects the **old** logic. The improved engines' profitability is
  **unproven** either way.
- Multi-session out-of-sample profitability **cannot be produced** today: intraday
  candles were never persisted (RCA-001), so sessions cannot be replayed.

**Profitability verdict: FAIL on real data (negative net expectancy); grade/quality/
probability profitability = INSUFFICIENT EVIDENCE.**
