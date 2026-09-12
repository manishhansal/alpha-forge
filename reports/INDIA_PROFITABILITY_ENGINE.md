# INDIA PROFITABILITY-SELECTION ENGINE

**Component:** `src/lib/india/profitability-engine.ts` (`pfe-1.0.0`)
**Tests:** `tests/lib/india/profitability-engine.test.ts` (29 tests, all passing)
**Status:** Engine + tests green. Wired to consume the prior engines as inputs;
awaiting production wiring of the upstream stages.
**Builds on:** `INDIA_SIGNAL_FORENSIC_AUDIT.md`,
`INDIA_PREDICTIVE_SIGNAL_QUALITY.md`, `INDIA_GRADE_VALIDATION.md`,
`INDIA_ML_CALIBRATION_REPORT.md`, `INDIA_STRATEGY_REGIME_MATRIX.md`.

---

## 0. Objective & what changed

The India opportunity engine was a **signal-validation** pipeline (does the setup
look valid?). This upgrade makes it a **profitability-selection** pipeline that
answers:

> "Is this trade worth taking **after** probability, payoff, cost, slippage,
> liquidity and uncertainty?"

The decision is based on **net expected value**, never gross. The forensic audit
found the old EV zeroed market impact and latency, and the paper-trade resolver
applied **no** costs at all — so every P&L was optimistic. This engine models the
full Indian F&O cost stack, realistic slippage (incl. option greeks), stresses
costs to 3×, and rejects fragile signals via counterfactual perturbation.

| Before | After |
|--------|-------|
| Gross EV / confidence ranking | **Net EV** after the full cost stack |
| Market impact = 0, no slippage at resolution | Explicit slippage model (liquidity/vol/TOD/moneyness/greeks/order-size) |
| A/A+ on gross edge | **Gross EV can never earn A/A+** — net-EV + cost-stress gated |
| No robustness check | Counterfactual perturbations + `robustnessScore` (reject fragile) |
| Max-pain/PCR/OI could imply direction | Derivatives are **confirm-only** unless a validated flow strategy |
| BUY/SELL | **TRADE / WATCH / WAIT / NO_TRADE** |

---

## 1. Net EV formula

```
grossEV%  = P(win) · E[win%] − P(loss) · E[loss%]           (E in R × riskPct)
netEV%    = grossEV% − totalCost%
```

Where `P(win)` is the **calibrated** probability from the ML meta layer (§ML
report) — never the heuristic confidence — and `totalCost%` is the full stack (§2).
Payoffs are expressed in R and converted to % of entry via `riskPct`, so the same
engine handles equities, futures and options.

---

## 2. Full India F&O cost stack

`computeCostBreakdown` itemises every component as a % of entry (round trip):

| Component | Basis |
|-----------|-------|
| Brokerage | flat per round-trip / notional |
| STT | sell-side rate × 100 |
| Exchange transaction | rate × 2 (both sides) |
| SEBI turnover | rate × 2 |
| GST | 18% of (brokerage + exchange + SEBI) |
| Stamp duty | buy-side rate |
| Spread | round-trip, from the slippage model |
| Slippage | from the slippage model |
| Market impact | from the slippage model |

Rates are per `InstrumentKind` (`COST_RATES`: INDEX_OPTION / STOCK_OPTION /
INDEX_FUT / STOCK_FUT / EQUITY) and are inputs, so they can be updated without a
code change. The flat brokerage is correctly amortised — small notionals carry a
larger brokerage % (tested).

---

## 3. Cost stress + costRobustnessScore

`computeNetEV` returns the full stress ladder:

```
EV_1x   = grossEV − totalCost × 1.0
EV_1.5x = grossEV − totalCost × 1.5
EV_2x   = grossEV − totalCost × 2.0
EV_3x   = grossEV − totalCost × 3.0
costRobustnessScore = clamp01( EV_2x / grossEV )     (0 when grossEV ≤ 0)
survives2x = EV_2x > 0
```

**A signal that only works before costs is downgraded or rejected.** Grading
(§7) requires `netEV > 0` AND `survives2x` even for a B; A requires cost
robustness ≥ 0.4; A+ requires `EV_3x > 0`. Gross EV cannot lift a net-negative
signal above REJECT — proven with a perfect-quality, perfect-probability input
that is still REJECTed because net EV is negative.

> Tests: cost-stress ladder is monotone decreasing; a cost-fragile signal
> (positive at 1×, negative at 2×) has `costRobustnessScore < 0.4`; a robust
> signal survives 3× costs.

---

## 4. Slippage + options microstructure model

`modelSlippage` produces round-trip `spreadPct`, `slippagePct`, `marketImpactPct`
from:

- **liquidity** — thin books widen slippage (×1–2.5),
- **spread** — quoted, or inferred from liquidity,
- **relative volume** — low RVOL worsens fills,
- **volatility** — higher vol → more slippage,
- **instrument type** — options carry option microstructure,
- **time of day** — open (09:15–09:30 ×1.8) and close (>15:15 ×1.6) are slippier
  than mid-session,
- **order size** — square-root market-impact law.

For **options** it additionally models the required microstructure:
`bidAskSpreadPct`, `iv`, `theta`, `gamma`, `vega`, `oi`, `volume`, `moneyness`,
`daysToExpiry`. Effects:
- **moneyness** — OTM ×1.4, deep-OTM ×2.2,
- **option liquidity** — thin OI (<5k) or volume (<1k) widen further,
- **expiry proximity** — expiry-day ×1.4,
- **greeks** — high IV widens quotes; high gamma/vega make fills unstable while
  crossing the spread; both add an execution-friction term to slippage.

The slippage output feeds directly into the cost stack, so it lands in net EV.

> Tests: thin-liquidity/low-volume/high-vol widen slippage; open/close > mid;
> larger order → more impact; deep-OTM thin-OI expiry-day options far slippier
> than liquid ATM; high IV/gamma/vega add friction.

---

## 5. Counterfactual perturbations + robustnessScore

`runCounterfactuals` re-computes net EV under the required perturbations:

| Scenario | Perturbation |
|----------|-------------|
| `delay_1_candle` / `delay_2_candle` | expected win decays by `delayDecayRPerCandle × c` |
| `slippage_2x` | slippage component doubled |
| `stop_10pct_wider` | loss ×1.1, risk ×1.1, win/R rescaled |
| `target_10pct_closer` / `target_10pct_farther` | expected win ×0.9 / ×1.1 |
| `entry_1hr_later` | expected win decays by `hourlyDecayR` |

```
robustnessScore    = fraction of scenarios with net EV > 0
worstCaseNetEVPct  = min net EV across scenarios
fragile            = base > 0 AND (robustnessScore < 0.7 OR worst < −max(0.05, base))
```

A robust signal retains positive net EV under reasonable perturbation; a fragile
one is demoted to WATCH or rejected.

> Tests: all 8 scenarios present; a strong signal stays ≥85% positive
> (`fragile=false`); a marginal-but-positive base with steep decay flips negative
> and is flagged `fragile=true`.

---

## 6. Derivatives confirm-only guard

`evaluateDerivativesGate` enforces the hard rule: **max-pain / PCR / OI must
CONFIRM an already-supported thesis, or come from a statistically-validated
independent options-flow strategy. They may never, alone, create a directional
trade.**

- `directionalThesisSupported = false` **and** not a validated flow strategy →
  `derivativesAloneRejected = true`, `allowed = false`.
- Otherwise → allowed, with `confirmationStrength = agreeCount / 3`.

> Tests: max-pain+PCR+OI agreeing but no supported thesis → rejected; the same
> derivatives confirming a supported thesis → allowed with strength 1.0; a
> validated options-flow strategy may use them as independent evidence; the
> pipeline `NO_TRADE`s a derivatives-alone signal.

---

## 7. The profitability-selection pipeline + decision

`runProfitabilityPipeline` runs the full pipeline and emits a stage-by-stage
trace:

```
Universe → Context → Multi-layer → Derivatives → Predictive Quality →
Calibrated Probability → Net EV → Cost Stress → Counterfactual →
Correlation Cluster → Conflict Resolution → Abstention → Risk → Grade
```

(The upstream stages — quality, calibrated probability, strategy×regime
suitability — are supplied as inputs from the engines already built, keeping this
module pure and testable.) The stage trace order is asserted by test.

### 7.1 Grade (net-EV gated)

`gradeProfitability`:
- **REJECT** — `netEV ≤ 0` OR fails 2× cost stress.
- **A_PLUS** — `EV_3x > 0`, cost robustness ≥ 0.6, robustness ≥ 0.85, quality ≥ 75,
  calibrated P ≥ 0.62, prob lower-bound ≥ 0.5.
- **A** — `EV_2x > 0`, cost robustness ≥ 0.4, robustness ≥ 0.7, quality ≥ 55,
  P ≥ 0.5.
- **B** — net positive, robustness ≥ 0.6, P ≥ 0.5.
- **C** — net positive but weak/fragile.

Gross EV can never reach A/A+ — the net-EV + cost-stress gates come first.

### 7.2 Decision — TRADE / WATCH / WAIT / NO_TRADE

- **NO_TRADE** — risk blocked, strategy suppressed in regime, derivatives-alone,
  net EV ≤ 0, fails 2× cost stress, or grade REJECT.
- **WAIT** — usable base edge but the model abstained (unsure) or a
  timeframe/derivatives conflict exists → wait for clarity.
- **WATCH** — positive but fragile, or highly correlated with the existing book,
  or only a marginal (C) edge → observe, don't commit.
- **TRADE** — net-positive, cost-robust, counterfactually-robust, uncorrelated,
  conflict-free, non-abstained edge.

> Tests exercise every branch: clean robust signal → TRADE; net-negative → NO_TRADE;
> abstain → WAIT; conflict → WAIT; high correlation → WATCH; risk block → NO_TRADE;
> strategy suppressed → NO_TRADE.

---

## 8. Validation results

### 8.1 Test suite

`tests/lib/india/profitability-engine.test.ts` — **29 tests, all passing**
(deterministic):

| Area | Result |
|------|--------|
| full cost stack components + total | ✅ |
| flat-brokerage amortisation | ✅ |
| gross-only signals cannot be A/A+ (REJECT even with perfect quality/prob) | ✅ |
| cost-stress ladder monotone; fragile fails 2×; robust survives 3× | ✅ |
| slippage: liquidity/volume/volatility/TOD/order-size | ✅ |
| options: moneyness/OI/volume/expiry/greeks widen slippage | ✅ |
| all 8 counterfactual scenarios; robust stays positive; fragile flagged | ✅ |
| derivatives confirm-only (alone rejected; confirm allowed; validated flow ok) | ✅ |
| decision mapping TRADE / WATCH / WAIT / NO_TRADE | ✅ |
| full stage-order trace | ✅ |
| determinism | ✅ |

### 8.2 Baseline (regression safety)

- `npx tsc --noEmit` → **exit 0**.
- `npx eslint` on both new files → **clean**.
- Full suite `npx vitest run` → **206 files / 3241 tests pass** (was 205 / 3212;
  +1 file, +29 tests). No existing test regressed.

---

## 9. Integration plan

1. **Feed upstream engine outputs** into `ProfitabilityPipelineInput`: predictive
   quality (`predictive-quality-engine`), calibrated probability + uncertainty
   (`ml-meta-decision`), strategy×regime suitability (`strategy-regime-scoring`),
   and the payoff geometry / slippage inputs from the market-data + option-chain
   layers.
2. **Populate real cost rates** from the current NSE/SEBI schedule (the defaults
   are realistic but should be verified against the live rate card).
3. **Calibrate the decay assumptions** (`delayDecayRPerCandle`, `hourlyDecayR`)
   and thresholds from OOS outcomes per strategy×regime.
4. **Replace** the opportunity-engine's BUY/SELL decision with
   `runProfitabilityPipeline`'s TRADE/WATCH/WAIT/NO_TRADE, and only route TRADE
   decisions to the paper/auto-trader.
5. **Apply the same cost stack at resolution** so realized P&L matches the net-EV
   the engine selected on (closing the audit's "no costs at resolution" gap).

The engine is pure and deterministic, so every decision is reproducible and
auditable from its `stages` trace and component results.
