# INDIA SIGNAL PROFITABILITY CERTIFICATION

**Scope:** End-to-end profitability certification of AlphaForge Indian-Market signals
after the signal-engine improvements (six engines + A+ Signal Factory).
**Certification date:** 2026-09-08
**Production logic changed during certification:** **NONE** (read-only assessment;
no engine, resolver, provider, or grade code was modified).
**Method:** Evidence-based. Where realized evidence is absent, the item is reported
as **NOT MEASURABLE / INSUFFICIENT EVIDENCE** — it is never inferred, extrapolated,
or synthesised into a pass.

---

## EXECUTIVE VERDICT

> # ❌ FAIL — A+ PROFITABILITY: **INSUFFICIENT EVIDENCE**

The system **cannot be certified profitable** today, and A+ superiority **cannot be
certified at all**, because the evidence required to prove it **does not exist**.
This is not a statement that the engines are wrong — it is a statement that the
**realized-outcome data needed to certify them is missing**, and the one real
dataset that does exist shows **negative net expectancy below break-even**.

| Certification pillar | Status |
|----------------------|--------|
| A signal is profitable only if realized **net expectancy > 0** after costs/slippage | ❌ **FAIL** — the only real dataset is **−0.18%/trade, −₹32,624** |
| A+ > A > B > C monotonicity on **realized** outcomes | ⚠️ **INSUFFICIENT EVIDENCE** — no grade-segmented realized outcomes exist |
| Multi-session out-of-sample realized data | ❌ **NOT AVAILABLE** — intraday history not persisted (RCA-001) |
| New A+/profitability stack wired into the live outcome path | ❌ **NOT WIRED** — pure libraries, driven only by injected inputs |

**Bottom line:** Do **not** promote any signal to LIVE on profitability grounds.
Do **not** publish A+ as a proven-superior tier. The correct action is to fix the
data-persistence blockers, wire the new stack, and re-run this certification over a
genuine multi-session out-of-sample window.

---

## WHY THIS VERDICT (the evidence chain)

### E1 — The only REAL realized dataset shows a losing edge
`reports/today-signal-ledger-2026-09-01.json` is a genuine DB export of **321 paper
trades resolved against live Angel One candles** (provider lineage: `angel_one` on
100% of trades; P&L reconciliation `VERIFIED_EXACT`). Recomputed directly from the
ledger:

| Metric | Value |
|--------|-------|
| Resolved trades | 47 WIN / 136 LOSS / 138 EXPIRED (321 total) |
| Resolved win rate `W/(W+L)` | **25.68%** |
| Average win | +0.6296% |
| Average loss | −0.4561% |
| Win/loss ratio | 1.380 |
| **Break-even win rate** (given the actual 1.38 W/L ratio) | **42.01%** |
| Gross expectancy per resolved trade | **−0.1773%** |
| Total realized P&L | **−₹32,624** (ledger unit) |

The realized win rate (**25.68%**) is **~16 points below** the break-even it must
clear (**42.01%**). The edge is **negative before** we even layer on the full cost
stack. **A high win rate is not claimed and would not save it — expectancy is
negative.** This satisfies the brief's rule: profitability requires realized net
expectancy > 0, and here it is < 0.

### E2 — There is no grade-segmented realized outcome data
The ledger records `strategyId`, `timeframe`, and `status`, but **not** the A+/A/B/C
grade of each trade. There is **no realized win rate / expectancy / profit factor per
grade** anywhere in the persisted data. Therefore the headline acceptance criteria —
**A+ > A, A > B, B > C on realized outcomes** — are **NOT MEASURABLE** from source.
Reporting them would require manufacturing grade labels and outcomes, which this
certification refuses to do.

### E3 — Multi-session out-of-sample data cannot be produced today
Per `reports/20-session-data-quality.json` and the master scorecard, **intraday
candles were never persisted (RCA-001)**. Past sessions therefore **cannot be
replayed** at the 1m/5m/15m horizons the strategies trade on. The "20-session"
figures elsewhere are **extrapolated from a single session**, not independently
realized — they are explicitly not certification-grade. Only daily OHLCV and
`OptionChainSnapshot` are replayable.

### E4 — The improved stack is not on the live outcome path
The six new engines and the A+ Signal Factory (`profitability-engine.ts`,
`a-plus-signal-factory.ts`, etc.) are **pure, deterministic, I/O-free libraries**.
A code search confirms `runProfitabilityPipeline` / `runAPlusFactory` are imported
**only by their own unit tests** — no worker, API, or feature wires them into the
runtime that produced the ledger. Their default weights are flagged
`UNTRAINED_UNIFORM_PRIOR`. Any win-rate/expectancy produced *through them* today is
driven by **synthetic candidate inputs**, not real fills. They cannot be certified
on real data until they are wired and run live.

---

## WHAT WAS ACTUALLY RUN (and what it proves)

| Ran | Result | What it certifies |
|-----|--------|-------------------|
| Ledger recomputation (E1) | negative expectancy, below break-even | The **live path** currently loses money |
| Look-ahead audit of the resolver | `paper-trader-core.resolveAgainstCandles`: a candle touching **both** stop and target is booked as a **stop/LOSS** (conservative) | ✅ **No look-ahead inflation** in outcome resolution |
| Provider-lineage audit | `angel_one` recorded on 100% of trades; failover chain `DATA_SERVICE→ANGEL_ONE→UPSTOX→YAHOO` implemented with `provider_switch` audit logs + per-trade provenance columns | ✅ **Lineage recorded**; chain correctly ordered |
| Duplicate-confirmation audit | Same opportunity appears on multiple timeframes → **1.31× inflation in this file** (project scorecard cites up to 3×) | ❌ **Duplicate inflation present** in the live path |
| Engine + signal-intelligence test suite | **345 tests pass** (india + signal-intelligence libraries) | ✅ **Structural integrity** of the engines — **not** profitability |

> Structural green (345 tests) proves the engines *compute what they claim*. It does
> **not** prove the signals *make money*. The two are being kept strictly separate.

---

## ACCEPTANCE CRITERIA — ITEMISED

| # | Criterion | Result | Basis |
|---|-----------|--------|-------|
| 1 | A+ outperforms A | ⚠️ INSUFFICIENT EVIDENCE | no grade-segmented realized outcomes (E2) |
| 2 | A outperforms B | ⚠️ INSUFFICIENT EVIDENCE | E2 |
| 3 | B outperforms C | ⚠️ INSUFFICIENT EVIDENCE | E2 |
| 4 | Quality score correlates with realized expectancy | ⚠️ INSUFFICIENT EVIDENCE | quality not persisted per resolved trade |
| 5 | Probability is calibrated | ⚠️ INSUFFICIENT EVIDENCE | no persisted predicted-prob vs realized-outcome pairs |
| 6 | Net EV predicts realized return | ⚠️ INSUFFICIENT EVIDENCE | net-EV engine unwired (E4); not stamped on fills |
| 7 | Higher-probability buckets → higher realized win rate | ⚠️ INSUFFICIENT EVIDENCE | E2 / E5 |
| 8 | Cost stress does not destroy the edge | ❌ FAIL (moot) | edge is already negative pre-stress (E1) |
| 9 | No look-ahead leakage | ✅ PASS | conservative both-touched→stop resolver |
| 10 | No survivorship bias | ⚠️ INSUFFICIENT EVIDENCE | universe is a static list; no delisting/eligibility history |
| 11 | No duplicate confirmation inflation | ❌ FAIL | 1.31× in-file, up to 3× per scorecard (DUP-001) |
| 12 | No signal-grade inflation | ⚠️ INSUFFICIENT EVIDENCE | anti-inflation checks exist in code but unverified on realized grades |
| 13 | No provider/data corruption | ✅ PASS (lineage) / ⚠️ (coverage) | lineage recorded + reconciliation exact; intraday coverage missing (RCA-001) |
| 14 | Strategy performance reported by regime | ⚠️ INSUFFICIENT EVIDENCE | regime not persisted per resolved trade in the ledger |
| 15 | Models evaluated only on untouched OOS | ⚠️ INSUFFICIENT EVIDENCE | no persistent OOS outcome store; learning loop is in-memory only |

**Not a single "A+ profitability" criterion is met by real evidence.** Two integrity
criteria pass (no look-ahead; lineage recorded), two fail on real data (negative edge;
duplicate inflation), and the rest are unmeasurable.

---

## STATISTICAL SIGNIFICANCE

With 183 resolved trades (47W/136L), the observed win rate is **25.68%**. A one-sided
test against the **42.01%** break-even is decisively **below** break-even — the point
estimate is ~16 points under the threshold with a sample this size, so the edge is
significantly negative, not merely noise. No significance test can rescue a point
estimate that far below break-even. Grade-level significance (A+ vs A, etc.) is
**not computable** — there are zero grade-segmented resolved trades (E2), so every
per-grade cell has n = 0.

---

## SECTION-BY-SECTION FINDINGS

Where a section requires realized, grade/regime-segmented outcomes that do not exist,
it is reported honestly as INSUFFICIENT EVIDENCE rather than filled with fabricated
numbers.

**1. Best strategies** — INSUFFICIENT EVIDENCE for a *profitable* ranking. The only
observable per-strategy volume in the real ledger is MOMENTUM (148), OPENING_BREAKOUT
(102), then options-flow strategies (LIQUIDITY_EDGE/IV_SPIKE/PCR_EXTREME/OI_BUILDUP,
9–12 each). None can be labelled "best" — the aggregate edge is negative and no
per-strategy resolved expectancy is persisted.

**2. Best regimes** — NOT MEASURABLE. Regime is not stamped on resolved trades in the
ledger; per-regime realized expectancy cannot be computed (fails criterion 14).

**3. Best instruments** — NOT MEASURABLE at grade/profit level. The ledger is
equity/index underlyings via Angel One; options-level realized outcomes are not
segmented.

**4. Best time windows** — NOT MEASURABLE. Intraday bars are not persisted (RCA-001),
so intraday time-of-day performance cannot be reconstructed.

**5. Best grades** — INSUFFICIENT EVIDENCE. This is the core gap: **no grade→outcome
mapping exists** in realized data.

**6. Best quality buckets** — INSUFFICIENT EVIDENCE. Quality score is not persisted
per resolved trade (fails criterion 4).

**7. Worst strategies** — INSUFFICIENT EVIDENCE per-strategy; **at the aggregate
level the whole live path is currently loss-making** (−0.18%/trade).

**8. Worst regimes** — NOT MEASURABLE (see #2).

**9. Failure modes (observed, real):**
  - Negative realized expectancy below break-even (E1).
  - Duplicate cross-timeframe confirmation inflation (DUP-001, criterion 11).
  - 138/321 trades EXPIRED (43%) — a large share never reach stop or target, dragging
    expectancy via time decay and cost with no directional resolution.
  - Improved A+/profitability stack not on the live path (E4), so the ledger reflects
    the *old* logic, not the improvements being certified.

**10. Calibration failures** — NOT MEASURABLE. No persisted predicted-probability vs
realized-outcome pairs; calibration (criterion 5) cannot be scored on real data.

**11. Data failures** — Intraday candle persistence missing (RCA-001) blocks replay
and MFE/MAE. Provider *lineage* is clean (lineage recorded, reconciliation exact), so
this is a **coverage/persistence** failure, not a corruption failure.

**12. Cost failures** — Moot but adverse: the edge is negative **before** the full
Indian F&O cost stack is applied, so cost realism only widens the loss. The
profitability engine models the full cost stack + 2×/3× stress, but it is unwired.

**13. Model failures** — The ML service is heuristic-fallback in the observed path
(no trained model active per the scorecard). Model value on real signals is
**NOT MEASURABLE**.

**14. Recommended production-safe signal subset** —

> **NONE.** On current real evidence there is **no signal subset that can be certified
> production-safe on profitability grounds.** Recommending any subset now would be
> manufacturing a result the data does not support.

---

## MONOTONICITY

**Cannot be evaluated on realized data.** (Note: the A+ factory's *unit tests* show
A+ > A > B monotonicity on a **synthetic** OOS harness — see
`reports/A_PLUS_SIGNAL_FACTORY_REPORT.md` §8 — but that is simulated ranking behaviour,
**not** realized market monotonicity, and is explicitly excluded from this
certification's verdict.)

---

## PATH TO A REAL CERTIFICATION (prerequisites, in order)

1. **Fix RCA-001** — persist intraday `CandleBar` data so sessions are replayable and
   MFE/MAE are computable.
2. **Fix DUP-001** — runtime cross-timeframe dedup so one opportunity is one trade
   (removes confirmation inflation, criterion 11).
3. **Persist grade, quality, calibrated probability, net EV, and regime on every
   resolved trade** — without these stamped at signal creation and carried to
   resolution, criteria 1–7 and 14 remain permanently unmeasurable.
4. **Wire the new stack** — route candidates through `runProfitabilityPipeline` /
   `runAPlusFactory`, and train `EvidenceWeights`/`OpportunityNormalization` on
   resolved outcomes (flip provenance to `LEARNED_OOS`).
5. **Run ≥ N live/paper sessions** across the required regimes and instruments, with
   broker credentials configured, then **re-run this certification** on the persisted,
   grade-segmented, untouched-OOS outcomes.
6. Only then evaluate A+ > A > B > C, calibration, EV→return, and cost robustness on
   **real** data.

---

## CERTIFICATION STATEMENT

Per the explicit instruction: **the evidence does not support A+ profitability**, so
this certification reports **INSUFFICIENT EVIDENCE** and does **not** manufacture A+
signals to satisfy the target. The one real realized dataset shows a **negative net
expectancy (−0.18%/trade) below the 42.01% break-even win rate**, duplicate
confirmation inflation is present, grade-segmented and multi-session out-of-sample
realized outcomes do not exist, and the improved engines are not yet on the live
outcome path.

**Verdict: FAIL — A+ profitability INSUFFICIENT EVIDENCE. Not production-eligible on
profitability grounds.**

*What passed:* look-ahead-safe resolution, recorded provider lineage with exact P&L
reconciliation, and structurally green engines (345 tests). *What is required before
a PASS is even possible:* the six prerequisites above.

---

*AlphaForge — India Signal Profitability Certification — 2026-09-08*
*"Do not declare success because win rate is high. A signal is profitable only if realized net expectancy > 0 after costs and slippage."*
