# INDIA STRATEGY × REGIME MATRIX

**Component:** `src/lib/signal-intelligence/strategy-regime-scoring.ts` (`srs-1.0.0`)
**Tests:** `tests/lib/signal-intelligence/strategy-regime-scoring.test.ts` (18 tests, all passing)
**Status:** Profiles + learners + selector + matrix implemented and green. Awaiting a
production outcome-DB export to fit and freeze the OOS feature-importance model and
the live strategy×regime matrix (the shipped defaults are profile priors + `SHADOW`).
**Builds on:** the audit and the prior engines
(`INDIA_SIGNAL_FORENSIC_AUDIT.md`, `INDIA_PREDICTIVE_SIGNAL_QUALITY.md`,
`INDIA_GRADE_VALIDATION.md`, `INDIA_ML_CALIBRATION_REPORT.md`).

---

## 0. Objective & what changed

**Objective:** stop scoring every strategy with one universal confluence formula.
The forensic audit (§15) found a single weight vector applied to ORB, momentum,
mean-reversion and options flow alike. That is wrong — a feature that matters for
an opening-range breakout (breakout volume) is *adverse* for a mean-reversion
fade.

**What changed:**

| Before | After |
|--------|-------|
| One confluence weight vector for all strategies | Per-strategy `StrategyProfile` + per-`strategy×regime×timeframe` learned weights |
| Feature weights hand-set globally | Weights **learned OOS** (permutation / MI / conditional IC / win-rate / expectancy), blended over profile priors by sample size |
| No regime awareness in scoring | Weights resolved per regime; a feature strong in trend can be zero/negative in range |
| Strategy always eligible | Regime-aware **selector** suppresses poor-in-regime & profile-unsuitable strategies |
| No health / decay | `strategyHealthScore` + statistically-meaningful `detectAlphaDecay` |
| No governance surface | `strategyRegimeMatrix` with `ACTIVE / CAUTION / SHADOW / DISABLED` (never auto-LIVE) |

---

## 1. The strategy inventory

Eleven implemented Indian strategies (confirmed from scanner `engine.ts`,
daily-pick buckets, ORB, AI signal and the options ground-truth):

| Strategy | Family | Horizon | Hold | Derivatives | Liquidity |
|----------|--------|---------|------|-------------|-----------|
| `OPENING_BREAKOUT` | BREAKOUT | SCALP | ~30m | no | HIGH |
| `MOMENTUM` | TREND | INTRADAY | ~4h | no | STANDARD |
| `VOLUME_BREAKOUT` | BREAKOUT | INTRADAY | ~4h | no | STANDARD |
| `RANGE_EXPANSION` | BREAKOUT | SWING | ~1d | no | STANDARD |
| `OI_BUILDUP` | OPTIONS_FLOW | INTRADAY | ~4h | yes | HIGH |
| `PCR_EXTREME` | MEAN_REVERSION | INTRADAY | ~2h | yes | VERY_HIGH |
| `IV_SPIKE` | OPTIONS_FLOW | INTRADAY | ~3h | yes | VERY_HIGH |
| `LIQUIDITY_EDGE` | OPTIONS_FLOW | INTRADAY | ~3h | yes | VERY_HIGH |
| `MAX_PAIN_GRAVITY` | MEAN_REVERSION | INTRADAY | ~3h | yes | VERY_HIGH |
| `AI_SIGNAL` | MULTI_FACTOR | INTRADAY | ~4h | no | STANDARD |
| `DAILY_PICK` | MULTI_FACTOR | SWING | ~1d | no | STANDARD |

---

## 2. StrategyProfile — per-strategy feature relevance (PRIORS)

Each strategy has a `StrategyProfile` specifying horizon, entry/stop/target
mechanisms, suitable/unsuitable regimes, best time-of-day windows, suitable
instruments, and derivatives/liquidity requirements — plus a **feature-relevance
map**: each feature is `REQUIRED` / `SUPPORTING` / `IRRELEVANT` / `ADVERSE`.

These map to **prior weights** (`RELEVANCE_PRIOR`): REQUIRED `+1.0`, SUPPORTING
`+0.4`, IRRELEVANT `0`, ADVERSE `-0.6`. **They are priors, not final weights** —
learned OOS importance overrides them when data is sufficient (§3).

Selected relevance maps (the brief's examples, encoded):

**ORB (`OPENING_BREAKOUT`)** — openingRangeStructure/breakoutVolume/vwapAlignment/
marketRegimeFit = REQUIRED; oiConfirmation/oiChange = SUPPORTING; rsi = SUPPORTING
(low/medium); maxPain/volatilityExpansion = IRRELEVANT.

**Trend (`MOMENTUM`)** — adx/trendStack/momentum/volume/vwapAlignment/
marketRegimeFit = REQUIRED; rsi/relativeStrength = SUPPORTING; **vwapDistance =
ADVERSE** (an over-extended pullback argues against continuation); pcr/maxPain =
IRRELEVANT.

**Mean-reversion (`PCR_EXTREME`)** — pcr/rsi/vwapDistance/volatilityExpansion =
REQUIRED; **trendStack/adx/breakoutScore/momentum = ADVERSE** (strong trend is the
enemy of a fade); maxPain/oiChange = SUPPORTING.

**Options directional (`OI_BUILDUP` / `LIQUIDITY_EDGE`)** — oiChange/oiConfirmation/
underlyingTrend = REQUIRED; pcr/liquidity/spread REQUIRED for the chain-heavy
ones; maxPain = SUPPORTING only; rsi = IRRELEVANT; liquidity requirement
VERY_HIGH.

> Test *"has a profile for every strategy with distinct feature relevance maps"*
> asserts ORB's map ≠ mean-reversion's map — the universal-formula smell test.

---

## 3. OOS-learned feature importance (strategy × regime × timeframe)

`learnFeatureImportance` fits, per `strategy × regime × timeframe` cell, a
`FeatureImportanceCell` for every feature combining four independent signals:

- **Permutation importance** — OOS log-loss degradation when the feature is
  shuffled (deterministic seeded shuffle).
- **Mutual information** — between the binned feature and the binary outcome.
- **Conditional IC** — Pearson corr of the feature with realized R.
- **Conditional win rate / expectancy** — of the feature's top tercile.

These combine into a signed `learnedWeight ∈ [-1,1]` (sign from IC). The
`effectiveWeight` is a **sample-shrunk blend of the learned weight over the
profile prior**:

```
sampleConfidence = n / (n + minSample)
effectiveWeight  = sampleConfidence · learnedWeight + (1 − sampleConfidence) · priorWeight
```

So a thin cell leans on the prior; a rich cell trusts the data. Resolution falls
back `strategy|regime|timeframe → strategy|regime|ANY → strategy|ANY|ANY →
profile priors`.

**This is the core of the refactor:** the *same* feature gets *different* weights
per strategy and per regime.

> Test *"the SAME feature earns different learned weights for ORB vs
> mean-reversion"*: with `breakoutVolume` driving ORB outcomes and `rsi` driving
> mean-reversion outcomes, the learner gives `breakoutVolume` a higher weight for
> ORB than for mean-reversion, and `rsi` the reverse. Test *"learned weights
> differ across REGIMES"*: `momentum` weighs more for MOMENTUM in a trend than in
> a range.

`scoreStrategyFeatures` produces the strategy's confluence score as a sign-aware
weighted average — **ADVERSE features subtract**, so a strong trend lowers a
mean-reversion score.

> Test *"adverse features push the score down"* confirms a mean-reversion setup
> scores lower when a strong trend is present.

---

## 4. strategyHealthScore + alpha-decay (statistically meaningful)

**`computeStrategyHealth`** blends the **Wilson lower bound** of the win rate
(0.35), normalised expectancy (0.30), profit factor (0.20) and a drawdown penalty
(0.15). It is **sample-aware**: the score is shrunk toward a neutral 0.5 by
`n/(n+minReliable)` and flagged `reliable=false` below the minimum. A strategy is
never condemned *or* promoted on a handful of trades.

**`detectAlphaDecay`** splits the time-ordered trades into an early and recent
half and flags `decaying` **only** when the recent window is statistically
meaningful (≥ `minWindow`) **and** the recent expectancy is below the early
expectancy by more than the sampling-noise band (`1.96 · SE`). A few losses can
never flip it.

> Test *"a few losses do NOT flip a healthy strategy to decaying"* vs *"a
> sustained, meaningful deterioration IS flagged"*. Test *"health is shrunk
> toward neutral and flagged unreliable on tiny samples"*: 90% wins on n=5 →
> score < 0.8, `reliable=false`.

---

## 5. strategyRegimeMatrix

`buildStrategyRegimeMatrix` produces one `StrategyRegimeCell` per
`strategy × regime`, with exactly the columns the brief requires:

| Column | Meaning |
|--------|---------|
| `strategyId`, `regime` | the cell |
| `sampleCount` | resolved trades |
| `winRate`, `winRateLB` | raw + Wilson lower bound |
| `expectancy` | expectancy in R |
| `profitFactor` | Σwins / \|Σlosses\| |
| `sharpe` | mean(R) / std(R) |
| `maxDrawdown` | peak-to-trough of the R equity curve |
| `currentHealth` | `strategyHealthScore` |
| `recommendedStatus` | ACTIVE / CAUTION / SHADOW / DISABLED |
| `regimeSuitable` | profile says the regime is suitable |
| `reasons` | why the status was chosen |

### 5.1 Recommended-status mapping (`recommendStatus`)

- **DISABLED** — statistically-meaningful negative edge (n ≥ minReliable,
  expectancy < 0, Wilson-LB < 0.35), OR confirmed alpha decay with negative
  recent expectancy.
- **SHADOW** — insufficient evidence (small sample) OR a regime the profile
  deems unsuitable → observe/paper only. This is the **default for a new
  strategy**.
- **CAUTION** — mild decay, or a weak/uncertain positive edge → reduced size.
- **ACTIVE** — statistically-meaningful positive edge in a suitable regime.

**There is no `LIVE` status.** Promotion to live is a human decision — the engine
never auto-promotes.

> Tests confirm each mapping (meaningful positive → ACTIVE, meaningful negative →
> DISABLED, thin sample → SHADOW) and *"recommendStatus NEVER returns a LIVE
> status"* across a grid of inputs.

---

## 6. Regime-aware strategy selector (the pipeline front)

The required pipeline —

```
Market Regime → Candidate Strategies → Strategy Suitability
   → Signal Generation → Strategy-Specific Probability
   → Signal Quality → EV → Grade
```

— is implemented at the front by `selectStrategiesForRegime(regime, matrix,
candidates)`, which returns a `StrategySuitability` per candidate with a
`suitability ∈ [0,1]` multiplier and a `suppressed` flag:

- `ACTIVE` → 1.0 (or 0.6 if the profile marks the regime merely tolerable),
- `CAUTION` → 0.5,
- `SHADOW` / `DISABLED` → 0 (suppressed — no live influence),
- profile-unsuitable regime → suppressed regardless of data.

The downstream stages (strategy-specific probability, quality, EV, grade) are the
engines already built: `ml-meta-decision` (calibrated probability),
`predictive-quality-engine` (quality), `evidence-grading-engine` (grade). This
module feeds them the regime-appropriate candidate set and the strategy-specific
feature weights.

> Test *"suppresses a strategy that performs poorly in the current regime"*:
> MOMENTUM (good in BULL, bad in RANGE) is un-suppressed in BULL and suppressed
> in RANGE. Test *"mean-reversion is eligible in RANGE where trend strategies are
> not"*: PCR_EXTREME eligible, MOMENTUM suppressed.

---

## 7. Validation results

### 7.1 Test suite

`tests/lib/signal-intelligence/strategy-regime-scoring.test.ts` — **18 tests, all
passing** (deterministic, seeded):

| Area | Result |
|------|--------|
| distinct per-strategy relevance maps (no universal formula) | ✅ |
| prior-weight ordering (REQUIRED > SUPPORTING > 0 > ADVERSE) | ✅ |
| same feature → different learned weight for ORB vs mean-reversion | ✅ |
| learned weights differ across regimes for the same strategy | ✅ |
| prior fallback when no learned cell | ✅ |
| adverse features push score down; scoring deterministic | ✅ |
| alpha decay: a few losses don't flip; sustained decay does | ✅ |
| health shrunk / unreliable on tiny samples; Wilson-LB dominance | ✅ |
| matrix status mapping ACTIVE / DISABLED / SHADOW | ✅ |
| recommendStatus never returns LIVE | ✅ |
| selector suppresses poor-in-regime & profile-unsuitable strategies | ✅ |

### 7.2 Baseline (regression safety)

- `npx tsc --noEmit` → **exit 0**.
- `npx eslint` on both new files → **clean**.
- Full suite `npx vitest run` → **205 files / 3212 tests pass** (was 204 / 3194;
  +1 file, +18 tests). No existing test regressed.

> The live strategy×regime matrix (real per-cell win rate / expectancy / PF /
> Sharpe / drawdown / status) is **NOT MEASURABLE FROM SOURCE — requires the
> outcome DB.** The aggregation harness (`buildStrategyRegimeMatrix`) already
> produces it; it just needs resolved `StrategyTrade[]` from production.

---

## 8. Integration plan (measure-first)

1. **Export** resolved trades as `StrategyTrade[]` (strategy, regime, label,
   returnR, outcomeMs) and importance observations as `FeatureImportanceObs[]`
   (features at signal time, label, returnR) from `PaperTrade`/`IndiaDailyPick`.
2. **Learn + freeze** the `FeatureImportanceModel` (`learnFeatureImportance`) and
   build the `strategyRegimeMatrix` (`buildStrategyRegimeMatrix`); persist both.
3. **Wire the front of the pipeline**: at signal time, classify the regime, call
   `selectStrategiesForRegime` to get the eligible candidates + suitability,
   generate signals only for un-suppressed strategies, and score each with
   `scoreStrategyFeatures` using the strategy×regime weights — replacing the
   universal confluence formula in `india-builder`/daily-picks.
4. **Feed** the strategy-specific score into the calibrated-probability →
   quality → EV → grade chain (the engines already built).
5. **Govern**: surface the matrix (statuses + health + decay) in the UI; refresh
   on each retrain; suppress/CAUTION automatically, but leave live promotion to a
   human.

Until step 2, the module uses profile priors for weights and `SHADOW` for
unproven strategy×regime cells — the safe default (nothing auto-goes-live, and no
strategy is scored by a borrowed weight vector).
