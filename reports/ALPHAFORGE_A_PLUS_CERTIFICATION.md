# ALPHAFORGE A+ CERTIFICATION

**A+ / A / B empirical performance.** Read-only. 2026-09-09.
**Rule: do not call A+ profitable without statistically significant evidence — use
INSUFFICIENT EVIDENCE instead.**

---

## EXECUTIVE VERDICT

> # ⚠️ A+ SUPERIORITY: INSUFFICIENT EVIDENCE (cannot be certified)

A+ cannot be certified as exceptional because **no resolved trade carries a grade**.
The only real outcome dataset (`today-signal-ledger-2026-09-01.json`, 321 trades) has
`grade` present in **0/321** trades — there is no A+/A/B/C label attached to any
realized outcome. Every A+-vs-A-vs-B comparison the audit requests is therefore
**NOT MEASURABLE FROM REAL DATA**.

---

## 1. WHAT WAS CHECKED

| A+ comparison (Phase 19) | Result |
|---|---|
| A+ sample count / win rate / expectancy / PF / avg R / median R | ❌ NOT MEASURABLE (no grade per trade) |
| A+ net P&L / cost-adjusted P&L / 2× cost EV | ❌ NOT MEASURABLE |
| A+ robustness / max drawdown / calibration | ❌ NOT MEASURABLE |
| A+ vs A vs B vs all-signals incremental value | ❌ NOT MEASURABLE |

There is **no runtime caller** of `runAPlusFactory` (verified by grep of
`src/{app,features,workers,server}`), so no A+ grade has ever been assigned to a real
trade in the first place.

---

## 2. WHAT *IS* KNOWN ABOUT A+ (unit-level only)

The A+ factory (`a-plus-signal-factory.ts`) is well-built and, on a **synthetic** OOS
harness, produces monotone A+>A>B on win rate / expectancy / profit factor (14 tests
pass). Design properties that hold in code:

- A+ requires **all 13** evidence conditions simultaneously + evidence ≥ 0.72 → rare
  by construction (no percentage quota).
- Correlation dedup uses the **geometric mean**, so duplicate NIFTY/BANKNIFTY LONGs
  cannot inflate confidence (the prompt's example collapses correctly).
- `OpportunityScore` zeroes on negative EV → ranks net-EV/risk, not confidence.

**These are simulation results, not market results.** They demonstrate the ranking
logic is internally correct; they do **not** demonstrate A+ trades make money.

---

## 3. ROBUSTNESS UNDER 2× COSTS / SAMPLE SIZE

- Robust under 2× costs? The engine models a 2×/3× cost-stress ladder and gates A+ on
  surviving it — **in code**. On **real** A+ trades: **NOT MEASURABLE** (none exist).
- Sufficient sample size? For real A+ outcomes the sample is **zero**.

---

## 4. CERTIFICATION STATEMENT

Per the audit's explicit instruction: because A+ has **no statistically significant
real-outcome evidence**, it is reported as **INSUFFICIENT EVIDENCE**, not profitable.
No A+ result was manufactured. To certify A+ in future: wire `runAPlusFactory` into the
signal path, persist grade + resolved outcome per trade, accumulate a real multi-
session OOS sample, then re-run Phase 19.

**A+ statistically validated? NO. Cost-adjusted profitable? INSUFFICIENT EVIDENCE.
Robust under 2× costs (real)? INSUFFICIENT EVIDENCE. Sufficient sample? NO (n=0).**
