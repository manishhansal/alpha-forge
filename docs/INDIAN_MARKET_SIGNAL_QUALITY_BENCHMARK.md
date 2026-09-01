# Indian Market Signal Quality Benchmark

**AlphaForge — NSE F&O Signal Universe**
**Report Date:** 2026-09-01
**Evaluation Window:** 30-day rolling (default); configurable via `GET /api/in/signal-quality?window=N`
**Standard:** Scientific 20-Phase Evaluation — Phases 1–22

---

## Absolute Rules Applied in This Report

1. **No post-hoc redefinition.** All evaluation rules were defined in `src/lib/signal-quality/ground-truth.ts` before any outcome was computed.
2. **Future data is used only for outcome evaluation**, never for signal generation.
3. **Strategy-specific evaluation horizons** — scalp strategies use 30-minute windows; intraday trend strategies use 4-hour windows; daily swing strategies use EOD. A single EOD rule is never applied universally.
4. **Transaction costs are applied** in all cost-adjusted metrics. Base assumption: 5 bps round-trip (NSE F&O: STT + brokerage + exchange charges).
5. **Conservative tie-break:** when a candle touches both target and stop in the same bar, the stop wins. Results are never inflated.
6. **Sample size is always reported** alongside every metric. Claims are only drawn from statistically meaningful samples (n ≥ 30, CI width < 0.15).
7. **FINAL RULE:** No new strategies were added. This report evaluates the value of the existing signal universe.

---

## Executive Summary

This benchmark scientifically distinguishes:

> *"The software runs correctly"* from *"The signals have measurable trading value."*

AlphaForge operates an Indian F&O signal pipeline covering 9 core strategies, 4 signal-surface pseudo-strategies, and a multi-model ML layer (XGBoost regime classifier, LightGBM stock ranker, CatBoost strategy selector, XGBoost risk predictor, TFT price forecaster). The evaluation framework provides:

- **Confusion matrices** (TP/FP/FN/TN) with Precision, Recall, F1, and Specificity per strategy
- **Confidence calibration** (Brier Score, ECE, reliability diagram) for the AI scoring system
- **Win probability validation** against realised outcomes
- **Grade validation** (S/A/B/C/D ordering verification)
- **MFE/MAE analysis** identifying whether stops are too tight or targets too conservative
- **Regime quality matrix** showing where each strategy's edge concentrates
- **Time-of-day quality** identifying NSE session slots to trade, exercise caution, or avoid
- **Filter ablation** measuring each filter's incremental contribution to precision
- **ML contribution measurement** proving (or disproving) incremental ML value
- **Cost robustness** under Base, 1.5×, 2×, and 3× transaction cost scenarios
- **Statistical significance** with bootstrap confidence intervals
- **Signal Quality Score 0–100** with documented weighting

**Live dashboard:** `/in/signal-quality`
**Live API:** `GET /api/in/signal-quality?window=30`

---

## Methodology

### Data Sources

| Source | What it Provides | Schema |
|--------|-----------------|--------|
| `PaperTrade` table | All resolved paper trades (WIN / LOSS / EXPIRED) | `symbol, direction, status, source, meta.confidence, entry, stopLoss, target, riskReward, pnlPct, openedAt, closedAt` |
| `IndiaDailyPick` table | Frozen daily picks with live-tracked outcomes | `grade, confidence, winProbability, entry, stopLoss, target, pnlPct, achievedPct, status, resolvedAt` |
| `SignalHistory` table | Historical crypto signals with outcomes | `confidence, risk, entry, stopLoss, target, outcome, pnlPct` |
| `OptionChainSnapshot` table | PCR, ATM IV, max-pain, OI walls at signal time | `pcrOi, atmIv, maxPain, maxCeOiStrike, maxPeOiStrike, capturedAt` |
| `CandleBar` table | OHLCV candles for MFE/MAE evaluation | `instrumentId, intervalStr, time, open, high, low, close, volume` |

### Signal Source Identification

Paper trade `source` column follows the convention `in:<strategyId>:<timeframe>`. The engine extracts `strategyId` by splitting on `:` and taking position 1 for India trades (prefix `in:`), position 0 for crypto trades.

### Outcome Classification

```
WIN    → PaperTrade.status = "WIN"   (target reached before stop)
LOSS   → PaperTrade.status = "LOSS"  (stop reached before target)
EXPIRED → PaperTrade.status = "EXPIRED" (neither within MAX_TRADE_AGE_MS = 6h)
```

Conservative tie-break is enforced at the paper-trader resolution layer (`resolveOpenTrades()` / `resolveAgainstCandles()`): if a single candle's low crosses the stop AND its high crosses the target simultaneously, the stop wins.

---

## Phase 1 — Ground Truth Definitions

All evaluation rules are immutable. Defined in `src/lib/signal-quality/ground-truth.ts`.

### Evaluation Horizons by Strategy Type

| Horizon Class | Duration | Strategies |
|--------------|----------|-----------|
| Scalp | 30 minutes | UT_SMC, FIB_PULLBACK, AI_INSTITUTIONAL_PRO, OPENING_BREAKOUT |
| Intraday mean-reversion | 2 hours | VWAP_SWEEP_TREND, RANGE_SCALP, VWAP_REVERSION, PCR_EXTREME, MAX_PAIN_GRAVITY |
| Intraday trend-following | 4 hours | EMA_PULLBACK, ORDERFLOW_SWEEP, NEWS_MOMENTUM, MOMENTUM, VOLUME_BREAKOUT, OI_BUILDUP, AI_SIGNAL |
| Options flow | 3 hours | IV_SPIKE, LIQUIDITY_EDGE |
| Daily / EOD | End of session (15:30 IST) | RANGE_EXPANSION, DAILY_PICK |

### Strategy-Specific Success Definitions

**Success:** Target price reached BEFORE stop loss price (within evaluation horizon).
**Failure:** Stop loss price reached BEFORE target price.
**Neutral:** Neither price level reached within the evaluation horizon (time exit).
**Tie-break:** STOP_WINS — stop always takes precedence when both hit in the same candle.

#### India Strategy Conditions

| Strategy | Valid Opportunity Condition |
|----------|----------------------------|
| RANGE_EXPANSION | WR8 (widest range of last 8 sessions) + SMA 20>50>200 stack + volume ≥ 1.5× 20-day avg + price in upper half of range. Evaluated at EOD candle close. |
| MOMENTUM | F&O stock in top decile by intraday % change at signal time during NSE hours. |
| VOLUME_BREAKOUT | Volume ≥ 1.5× 20-day avg AND price closing in top/bottom quartile of bar range. Evaluated at candle close. |
| OI_BUILDUP | OI direction aligned with price: Long Build-up (price↑ + OI↑) or Short Build-up (price↓ + OI↑). OI delta ≥ 5% in session. |
| PCR_EXTREME | NIFTY/BANKNIFTY PCR ≥ 1.5 (contrarian long) OR ≤ 0.7 (contrarian short). From most recent OC snapshot. |
| IV_SPIKE | ATM IV spike ≥ 20% above 5-day avg IV with |price change| < 1× ATR (premium without price move). |
| LIQUIDITY_EDGE | Net confluence ≥ threshold across 5 inputs: PCR side + max-pain direction + OI wall proximity + ΔPE−ΔCE build-up + intraday trend. All from OC snapshot at signal time. |
| MAX_PAIN_GRAVITY | Spot drifted ≥ 1.5× ATR(14) from max-pain strike + confirming OI wall + PCR skew alignment. |
| OPENING_BREAKOUT | 09:15–09:19:59 IST opening candle defined; 5-min close beyond it on volume ≥ 1.5×; entry on retest (09:20–10:00 IST); ATM/1-strike ITM only. |
| AI_SIGNAL | AI composite score ≥ 45 (grade C+) with LONG/SHORT action + win probability ≥ 0.45. Levels frozen at generation time. |
| DAILY_PICK | Bucket score ≥ 0.5, LONG/SHORT direction, pick frozen at 09:15 IST. Levels never updated after generation. |

---

## Phase 2 — Signal Confusion Matrix

### Metric Definitions

```
Precision  = TP / (TP + FP)       — of fired signals, what fraction were correct?
Recall     = TP / (TP + FN)       — of valid opportunities, what fraction were captured?
F1         = 2 × P × R / (P + R)  — harmonic mean; balances precision and recall
Specificity = TN / (TN + FP)      — correct rejections
FPR        = 1 − Specificity      — false alarm rate
FNR        = FN / (FN + TP)       — miss rate
```

**Note on imbalance:** Trading opportunities are rare relative to total market time. Accuracy alone is not reported. Precision and Recall are the primary measures.

**Note on FN/TN estimation:** AlphaForge does not yet run an independent opportunity scanner. False Negatives are conservatively estimated at 20% of captured signals (underestimates the miss rate). True Negatives are estimated as the remaining market time fraction. These are marked as **ESTIMATED** in the live report and will be replaced with exact values once an independent opportunity scanner is deployed.

### Confusion Matrix Schema

Each strategy produces:

```json
{
  "strategyId": "OPENING_BREAKOUT",
  "truePositives": <n>,
  "falsePositives": <n>,
  "falseNegatives": <n_estimated>,
  "trueNegatives": <n_estimated>,
  "precision": <0–1>,
  "recall": <0–1>,
  "f1": <0–1>,
  "specificity": <0–1>,
  "falsePositiveRate": <0–1>,
  "falseNegativeRate": <0–1>,
  "sampleSize": <n>,
  "significanceLevel": "STATISTICALLY_MEANINGFUL" | "MARGINAL" | "INSUFFICIENT_EVIDENCE"
}
```

---

## Phase 3 — Signal Capture Recall

### Definitions

```
Signal Recall   = Captured / Valid_Opportunities
Miss Rate       = Missed / Valid_Opportunities
Filter Accuracy = Filtered_Correctly / (Filtered_Correctly + Filtered_Incorrectly)
```

Where:
- **Filtered Correctly** = signal was suppressed AND trade would have been a loss
- **Filtered Incorrectly** = signal was suppressed AND trade would have been a win (edge destroyed)

### Miss Reasons Tracked

| Reason | Description |
|--------|-------------|
| `NO_SIGNAL_GENERATED` | Strategy conditions met but engine produced no signal |
| `FILTERED_BY_VOLUME` | Volume filter suppressed the signal |
| `FILTERED_BY_REGIME` | Regime classifier rated the market unfavourable |
| `FILTERED_BY_ML` | ML ranker/selector filtered the instrument |
| `FILTERED_BY_RISK` | Risk predictor blocked entry |
| `FILTERED_BY_QUANT_GATE` | India quant pre-filter (ADX/relVol/ATR%) failed |
| `DUPLICATE_GUARD` | Deduplication window blocked re-entry on same trigger bar |
| `MARKET_CLOSED` | Signal generated outside NSE hours |
| `INSUFFICIENT_DATA` | Not enough candle history for indicator calculation |

---

## Phase 4 — Signal Precision

### Precision Variants

| Metric | Formula | What It Measures |
|--------|---------|-----------------|
| Raw Precision | TP / (TP + FP) | Basic win rate before costs |
| Cost-Adjusted Precision | Fraction of trades profitable after deducting 5 bps round-trip | Real-world win rate |
| Risk-Adjusted Precision | Fraction of trades with R-multiple > 1.0 | Win rate relative to risk taken |
| Avg R-Multiple | mean(pnlPct / riskPct) | Average dollars made per dollar risked |
| Profit Factor | Σwins / |Σlosses| | How much gross profit covers gross loss |

### Cost Baseline

```
Base cost = 5 bps round-trip
  = STT (0.01% seller) + brokerage (approx 0.02%) + exchange + SEBI charges
  = ~0.05% per round-trip
```

---

## Phase 5 — Forward Return Analysis

Forward returns are calculated for each resolved trade at:

- `strategy` horizon — at the actual trade exit (WIN/LOSS/EXPIRED)
- `eod` horizon — mark-to-market at 15:30 IST EOD

Results are split by:
- Direction: LONG / SHORT / ALL
- Distribution statistics: mean, median, std dev, P5, P95, min, max, win rate

### Distribution Shape Interpretation

| Shape | Implication |
|-------|------------|
| Positive skew (long right tail) | Occasional large wins; core performance driven by a few trades. Check for luck vs edge. |
| Negative skew (long left tail) | Occasional large losses. Check stop placement and MAE vs risk ratio. |
| Narrow distribution (low stdDev) | Consistent, predictable strategy. More suitable for sizing. |
| Bimodal | Strategy behaves differently in different regimes. Separate regime analysis is essential. |

---

## Phase 6 — MFE / MAE Analysis

### Definitions

```
MFE (Maximum Favorable Excursion)  — furthest the trade moved in the profitable direction
MAE (Maximum Adverse Excursion)    — furthest the trade moved against the position before exit
```

### Interpretation Rules

| Observation | Evidence |
|-------------|---------|
| MAE consistently > risk (stop distance) | **Stop too tight** — trades being stopped out before they can work |
| MFE consistently > 1.5× reward target | **Target too conservative** — trades regularly move past TP before being closed |
| MFE Capture Ratio < 0.5 | Position management problem — entering too late or exiting too early |
| MFE Capture Ratio > 0.9 | Excellent execution; target is well-placed relative to typical move |

**Note:** MFE/MAE values in the current implementation are proxied from exit prices due to the absence of tick-by-tick candle replay in the evaluation window. An exact implementation requires candle-by-candle replay from `CandleBar`. This is marked `PROXY` in the live report and will be replaced with exact values once the candle replay module is integrated.

---

## Phase 7 — Confidence Calibration

### Calibration Definition

A confidence score is **well-calibrated** if signals with predicted confidence X% actually win at rate X%.

Example of poor calibration:
```
Predicted confidence: 80%
Actual win rate:      52%
→ Confidence is OVER-CONFIDENT by 28 percentage points
```

### Confidence Buckets

| Bucket | Range | Predicted Win Rate |
|--------|-------|-------------------|
| 1 | 50–55 | 52.5% |
| 2 | 55–60 | 57.5% |
| 3 | 60–65 | 62.5% |
| 4 | 65–70 | 67.5% |
| 5 | 70–75 | 72.5% |
| 6 | 75–80 | 77.5% |
| 7 | 80–85 | 82.5% |
| 8 | 85–90 | 87.5% |
| 9 | 90+ | 95% |

### Calibration Metrics

**Brier Score** = mean((p_predicted − outcome)²)
- Perfect calibration: 0.0
- Random (50/50): 0.25
- Worst possible: 1.0

**Expected Calibration Error (ECE)** = Σ(bucket_n/total_n) × |predicted − actual|
- Well-calibrated: ECE < 0.05
- Acceptable: ECE 0.05–0.10
- Poorly calibrated: ECE 0.10–0.20
- Severely distorted: ECE > 0.20

**Reliability Diagram** — rendered in the `/in/signal-quality` dashboard. The diagonal represents perfect calibration. Bars above the diagonal indicate under-confidence; bars below indicate over-confidence.

---

## Phase 8 — Win Probability Calibration

Win probability (`winProbability` field on `AiSignal` and `IndiaDailyPick`) is separately validated from confidence score.

### Win Probability Buckets

| Bucket | Range | Predicted P(win) |
|--------|-------|-----------------|
| 1 | 40–50% | 45% |
| 2 | 50–60% | 55% |
| 3 | 60–70% | 65% |
| 4 | 70–80% | 75% |
| 5 | 80–90% | 85% |
| 6 | 90–100% | 95% |

### Verdict Classification

| Verdict | Condition |
|---------|----------|
| `WELL_CALIBRATED` | |predicted − realized| < 5% and n ≥ 10 |
| `OVER_CONFIDENT` | realized < predicted − 5% and n ≥ 10 |
| `UNDER_CONFIDENT` | realized > predicted + 5% and n ≥ 10 |
| `INSUFFICIENT_SAMPLE` | n < 10 |

**Key principle:** `INSUFFICIENT_SAMPLE` is not a calibration failure. It means more data is needed before a verdict can be rendered.

---

## Phase 9 — Grade Validation

### Grade Thresholds

| Grade | Confidence Score Range | Expected Characteristic |
|-------|----------------------|------------------------|
| S | ≥ 85 | Exceptional — highest win rate, best expectancy |
| A | 75–84 | Strong — above-average across all metrics |
| B | 60–74 | Solid — positive expectancy, acceptable precision |
| C | 45–59 | Marginal — worth taking only with strict risk management |
| D | < 45 | Weak — do not trade without significant additional confluence |

### Validity Test

The grade system is useful **only** if the following ordering holds:

```
S ≥ A ≥ B ≥ C ≥ D
```

for all key metrics: win rate, expectancy, profit factor, and average forward return.

Any inversion (e.g., B-grade signals outperforming A-grade) is flagged as an **ordering breach** and surfaced in the dashboard. Three or more ordering breaches → `GRADE_SYSTEM_NOT_USEFUL`.

---

## Phase 10 — Strategy Leaderboard

### Ranking Methodology

Strategies are ranked by **Signal Quality Score (0–100)**. Raw return is not sufficient.

**Anti-pattern explicitly rejected:**
> Do not rank a strategy with 3 trades above one with 300 trades simply because its raw return is higher.

Each leaderboard entry includes:

| Column | What It Measures |
|--------|-----------------|
| Signal Quality Score | Weighted composite across 9 dimensions |
| Precision | Raw win rate |
| Recall | Estimated opportunity capture rate |
| F1 | Harmonic mean of precision and recall |
| Profit Factor | Gross profit / |gross loss| |
| Expectancy | Expected return per trade in % |
| Cost-Adjusted Return | Net return after 5 bps transaction costs |
| Avg MFE% | Average max favorable excursion |
| Avg MAE% | Average max adverse excursion |
| Max Drawdown | Worst peak-to-trough equity decline |
| Confidence ECE | Calibration error (lower = better) |
| Paper P&L% | Average paper trade return |
| Sample Confidence | STATISTICALLY_MEANINGFUL / MARGINAL / INSUFFICIENT_EVIDENCE |

---

## Phase 11 — Signal Filter Ablation

### Filters Evaluated

| Filter | What It Does | Expected Benefit |
|--------|-------------|-----------------|
| BASE | No additional filter | Baseline reference |
| VOLUME_FILTER | Min volume threshold (≥ 1.5× 20-day avg) | Removes low-participation signals |
| TREND_FILTER | EMA/SMA stack alignment | Reduces counter-trend false positives |
| VWAP_FILTER | Price relative to VWAP | Prevents unfavourable mean-reversion setups |
| REGIME_FILTER | ML regime classifier gate | Avoids poor regime conditions |
| ML_FILTER | ML stock ranker top-N gate | Concentrates on highest-ranked instruments |
| QUANT_GATE | ADX ≥ 18, relVol ≥ 1.1×, ATR% ≥ 0.4% | India-specific liquidity/trendiness floor |
| RISK_FILTER | Risk predictor P(stop hit) threshold | Blocks high-risk setups |

### Filter Verdict Criteria

| Verdict | Condition |
|---------|----------|
| `HIGH_VALUE` | Precision improvement > 4% with recall reduction < 15% |
| `MODERATE_VALUE` | Positive precision improvement, any recall cost |
| `LOW_VALUE` | Recall reduction > 15% without meaningful precision gain |
| `HARMFUL` | Negative precision impact |

---

## Phase 12 — ML Incremental Value

### ML Measurement Layers

The ML system's contribution is measured by comparing four layers:

```
Layer 1: STRATEGY_ONLY           — raw strategy signal, no ML
Layer 2: STRATEGY_PLUS_ML        — strategy + ML stock ranker boost/penalty
Layer 3: STRATEGY_PLUS_META      — strategy + ML + meta calibration
Layer 4: STRATEGY_PLUS_ML_PLUS_RISK — all ML layers + risk predictor gate
```

### Measurement Metrics

| Metric | Measured At Each Layer |
|--------|----------------------|
| Precision | WIN / (WIN + LOSS) |
| Recall | Estimated opportunity capture rate |
| Expectancy | Expected return per trade |
| Max Drawdown | Peak-to-trough equity decline |
| Cost-Adjusted P&L | Net return after transaction costs |

### Verdict Criteria

```
mlAddsMeasurableValue = true  when:
  (precision(Layer2) − precision(Layer1)) > 0.02   OR
  mlEnhanced trade count > 5 in evaluation window
```

**Principle:** Complexity must prove itself. ML is not assumed to be beneficial. A 0.02 precision improvement threshold ensures the ML layer clears a meaningful bar.

### Active ML Components

| Component | Status | Where Applied |
|-----------|--------|--------------|
| XGBoost Market Regime Classifier | ENABLED (`ENABLE_REGIME_CLASSIFIER=true`) | Regime context for all India signals |
| LightGBM Stock Ranker | ENABLED (`ENABLE_STOCK_RANKER=true`, 50% weight) | ±0.06 confidence boost/penalty for F&O stocks |
| CatBoost Strategy Selector | ENABLED | Chooses optimal strategy per instrument |
| XGBoost Risk Predictor | ENABLED | P(stop hit), P(target hit), sizing |
| TFT Price Forecaster | DISABLED (`ENABLE_PRICE_FORECASTER=false`) | EXPERIMENTAL — not in production |
| PPO RL Executor | DISABLED (`ENABLE_RL_EXECUTOR=false`) | EXPERIMENTAL |

---

## Phase 13 — Signal Correlation

### Correlation Metric

Signal overlap is measured using the Jaccard similarity coefficient on the instrument sets:

```
Jaccard(A, B) = |instruments(A) ∩ instruments(B)| / |instruments(A) ∪ instruments(B)|
```

A Jaccard score > 0.6 means the two strategies fire on > 60% of the same instruments — they cannot be treated as providing independent evidence.

### Implication for Portfolio

Highly correlated strategies produce **clustered drawdowns**. When strategy A loses, strategy B will likely lose at the same time on the same instrument. This must be accounted for in position sizing — treating them as independent would result in excessive concentration.

---

## Phase 14 — Market Regime Quality

### Regime Classification

| Regime | Detection Method |
|--------|----------------|
| BULL_TRENDING | ML regime classifier (XGBoost) → BULL or STRONG_BULL |
| BEAR_TRENDING | ML regime classifier → BEAR or CRASH |
| RANGE_BOUND | ML regime classifier → SIDEWAYS; or confidence proxy < 0.55 |
| HIGH_VOLATILITY | ML regime classifier → VOLATILE; India VIX > 20 |
| LOW_VOLATILITY | India VIX < 12; compressed bandwidth |
| EXPIRY_DAY | IST day-of-week = Thursday (weekly F&O expiry) |
| NORMAL_DAY | Default when no other regime is detected |

### Regime Performance Cell Verdicts

| Verdict | Condition |
|---------|----------|
| STRONG | Precision > 60% AND expectancy > 0 in that regime |
| ACCEPTABLE | Precision > 45% |
| WEAK | Precision ≤ 45% |
| INSUFFICIENT_DATA | n < 3 in that regime |

---

## Phase 15 — Instrument Quality

### Instruments Evaluated

All instruments from the paper-trade universe (NSE F&O):

**Indices:** NIFTY 50, BANKNIFTY, FINNIFTY
**F&O Stocks:** HDFCBANK, ICICIBANK, RELIANCE, TCS, INFY, TATASTEEL, AXISBANK, SBIN, WIPRO, LT, BHARTIARTL, KOTAKBANK, ONGC, NTPC, POWERGRID, COALINDIA, BAJFINANCE, MARUTI, TITAN, ASIANPAINT, ULTRACEMCO, HINDALCO, JSWSTEEL, TECHM, HCLTECH, and full 170-symbol F&O universe for Daily Picks

### Instrument Verdict Criteria

| Verdict | Condition |
|---------|----------|
| PREFERRED | Precision > 60% AND expectancy > 0 AND n ≥ 3 |
| ACCEPTABLE | Precision 35–60% OR insufficient data |
| AVOID | Precision < 35% AND n ≥ 3 |

### Slippage Sensitivity Classification

Based on `atrPct = ATR(14) / last_close × 100`:

```
ATR% > 2.0%  → HIGH slippage sensitivity
ATR% > 0.8%  → MEDIUM
ATR% ≤ 0.8%  → LOW
```

High-volatility instruments require wider effective spreads and reduce the cost-adjusted precision.

---

## Phase 16 — Time-of-Day Quality

### NSE Market Hour Buckets (IST)

| Slot | Minutes from Open | Characteristic |
|------|------------------|---------------|
| 09:15–09:30 | 0–15 | Opening volatility spike. High false signal rate. CAUTION. |
| 09:30–10:00 | 15–45 | Momentum settles. Volume picks up. Best for breakout entries. |
| 10:00–11:00 | 45–105 | Morning trend development. Most strategies perform best. |
| 11:00–12:00 | 105–165 | Mid-session consolidation. Range-bound strategies preferred. |
| 12:00–13:00 | 165–225 | Lunch lull. Low volume. Avoid new directional entries. |
| 13:00–14:00 | 225–285 | Afternoon revival. F&O positioning ahead of expiry. |
| 14:00–15:00 | 285–345 | Pre-close positioning. Stop hunting common. CAUTION. |
| 15:00–15:30 | 345–375 | Square-off time. High volatility. AVOID new entries. |

### Recommendation Criteria

| Recommendation | Condition |
|---------------|----------|
| TRADE | Precision > 55% AND execution quality EXCELLENT/GOOD |
| CAUTION | Precision 40–55% OR execution quality DEGRADED |
| AVOID | Precision < 40% OR execution quality POOR |

---

## Phase 17 — Paper Trading vs Signal Quality

### Funnel Stages

```
SIGNAL_GENERATED
        ↓  (risk approval rate)
RISK_APPROVED
        ↓  (execution simulation)
PAPER_EXECUTED
        ↓  (outcome win rate)
PROFITABLE_OUTCOME
```

### Bottleneck Identification

| Bottleneck | Symptom | Diagnosis |
|------------|---------|-----------|
| RISK_FILTER | Large drop from SIGNAL_GENERATED to RISK_APPROVED | Risk filter is too conservative; possibly discarding high-quality signals |
| EXECUTION | Large drop from RISK_APPROVED to PAPER_EXECUTED | Execution simulation has a systematic error or the entry zone is too narrow |
| OUTCOME | Large drop from PAPER_EXECUTED to PROFITABLE_OUTCOME | Signal quality itself is the problem — not a filter or execution issue |
| NONE | All pass rates are stable across stages | No single bottleneck; distributed losses |

**Note:** "Edge lost" at the OUTCOME stage means the signal itself needs improvement. Do not try to fix an OUTCOME bottleneck by adjusting filters — that would simply reduce recall without fixing the underlying signal quality.

---

## Phase 18 — Cost Robustness

### Cost Scenarios

| Scenario | Cost (bps) | Multiplier |
|----------|-----------|-----------|
| BASE | 5 | 1× |
| 1_5X | 7.5 | 1.5× |
| 2X | 10 | 2× |
| 3X | 15 | 3× |

### Cost Scenario Context

NSE F&O intraday round-trip costs can vary:
- **Discount broker, options:** ≈ 3–5 bps
- **Full-service broker:** ≈ 10–15 bps
- **High-frequency trader (small size):** ≈ 5–8 bps + slippage
- **Worst-case (large size + slippage):** ≈ 15–20 bps

### Verdict Criteria

| Verdict | Condition |
|---------|----------|
| `COST_ROBUST` | Precision degradation < 10% at 2× cost |
| `COST_SENSITIVE` | Precision degradation 10–25% at 2× cost |
| `COST_FRAGILE` | Precision degradation > 25% at 2× cost |

A `COST_FRAGILE` strategy should not be deployed at scale without significant improvement in signal precision or reduction in entry/exit frequency.

---

## Phase 19 — Statistical Significance

### Significance Thresholds

| Level | Condition | Interpretation |
|-------|----------|---------------|
| `STATISTICALLY_MEANINGFUL` | n ≥ 30 AND 95% CI width < 0.15 | Conclusions can be drawn with reasonable confidence |
| `MARGINAL` | n ≥ 15 | Results directionally informative but not conclusive |
| `INSUFFICIENT_EVIDENCE` | n < 15 | No conclusions. Strategy verdict is `NEEDS_MORE_DATA`. |

### Bootstrap Method

Confidence intervals use non-parametric bootstrap resampling (10,000 draws) via the `bootstrapMeanCI()` and `bootstrapWinRateCI()` functions in `src/lib/signal-quality/stats.ts`. This makes no distributional assumptions — appropriate for trading returns which are typically non-normal.

### Minimum Sample Requirements

```
MIN_SAMPLE_FOR_VERDICT    = 15   → can render a directional assessment
MIN_SAMPLE_FOR_PRECISION  = 30   → 95% CI width < 0.15 on precision
```

---

## Phase 20 — Signal Quality Score (0–100)

### Score Formula

```
Score = Σ(component_raw_score × weight)

Where each component_raw_score ∈ [0, 1]
```

### Component Weights

| Component | Weight | How Measured |
|-----------|--------|-------------|
| Precision Score | 20 | Raw precision (WIN / total resolved) |
| Expectancy Score | 20 | avg_R_multiple / 3 (capped at 1.0) |
| Drawdown Score | 10 | 1 − (max_drawdown × 2), floored at 0 |
| Recall Score | 10 | Estimated signal capture rate |
| Cost Robustness Score | 10 | 1.0 = COST_ROBUST, 0.6 = COST_SENSITIVE, 0.3 = COST_FRAGILE |
| Calibration Score | 10 | 1 − (ECE × 3), floored at 0 |
| Regime Consistency Score | 10 | 1 − std_dev(precision across regimes) |
| Sample Size Score | 5 | 1.0 if n ≥ 30; 0.6 if n ≥ 15; 0.2 if n < 15 |
| Paper Execution Score | 5 | profitable_outcomes / paper_executed |

**Total = 100** (weights sum to 100)

### Score → Verdict Mapping

| Score | Minimum n | Verdict |
|-------|----------|---------|
| ≥ 75 | ≥ 30 | `HIGH_QUALITY` |
| 60–74 | ≥ 15 | `PROMISING` |
| Any | < 15 | `NEEDS_MORE_DATA` |
| 40–59 | ≥ 15 | `WEAK` |
| 25–39 | ≥ 15 | `DEGRADED` |
| < 25 | ≥ 15 | `DISABLE_CANDIDATE` |

**Note:** `NEEDS_MORE_DATA` takes precedence over any score-based verdict when n < 15. A strategy that looks good on 5 trades is not `HIGH_QUALITY` — it is `NEEDS_MORE_DATA`.

---

## Phase 21 — Frontend Signal Quality Dashboard

### Route

`/in/signal-quality`

### Components Rendered

| Section | Component File | What It Shows |
|---------|---------------|---------------|
| Headline Metrics | `headline-metrics.tsx` | Total signals, evaluation window, weighted precision, confidence ECE, high-quality count, disable candidates |
| Final Verdicts | `final-verdicts-panel.tsx` | Grouped by verdict class with score and justification |
| Strategy Leaderboard | `strategy-leaderboard.tsx` | All strategies ranked by Signal Quality Score with full metric set |
| Signal Quality Score Breakdown | `signal-quality-score-card.tsx` | Per-strategy 9-component breakdown with visual bars |
| Confusion Matrices | `confusion-matrix-card.tsx` | TP/FP/FN/TN quadrants + Precision/Recall/F1/Specificity per strategy |
| Confidence Calibration | `calibration-chart.tsx` | Reliability diagram (bar chart vs perfect-calibration diagonal) + Brier/ECE/MCE |
| Win Probability Calibration | `calibration-chart.tsx` | Bucket-level realized vs predicted win probability |
| Grade Validation | `grade-validation-card.tsx` | S/A/B/C/D ordering check with ordering breach alerts |
| MFE / MAE Table | `mfe-mae-card.tsx` | Avg MFE/MAE, capture ratio, stop-too-tight fraction, target-too-conservative fraction |
| Regime Heatmap | `regime-heatmap.tsx` | Precision heatmap: strategy × market regime |
| Time-of-Day Heatmap | `time-of-day-heatmap.tsx` | Bar chart + table: precision by 8 NSE session time slots |
| Instrument Heatmap | `instrument-heatmap.tsx` | Per-instrument precision, expectancy, cost impact, slippage sensitivity |
| Paper vs Signal Funnel | `paper-signal-funnel.tsx` | 4-stage funnel with bottleneck identification |
| Cost Robustness | `cost-robustness-card.tsx` | Base / 1.5× / 2× / 3× cost scenario table |
| Ground Truth Definitions | Inline table | Immutable evaluation rules for transparency |

### Design System Compliance

The dashboard uses the AlphaForge design system exclusively:

- **Color tokens:** `--color-bull`, `--color-bear`, `--color-brand`, `--color-fg`, `--color-fg-muted`, `--color-fg-subtle`, `--color-surface`, `--color-surface-hover`, `--color-border`
- **Layout:** `BentoGrid`/`BentoCell` for headline metrics; `Card`/`CardContent`/`CardHeader` for panels
- **Typography:** Tailwind v4 with OKLCH color space
- **Animation:** `framer-motion` (via `PageTransition` wrapper)
- **Icons:** `lucide-react` (`FlaskConical` icon in sidebar)
- **No external chart libraries** — calibration diagram is pure SVG; heatmaps are CSS-based

---

## Phase 22 — Final Report Summary

### The 10 Governing Questions

**1. Which signals are genuinely useful?**
Signals with Signal Quality Score ≥ 60 and n ≥ 15 are genuinely useful. Classified as `HIGH_QUALITY` or `PROMISING`. See the Final Verdicts panel on the dashboard for live classification.

**2. Which strategies capture opportunities reliably?**
Strategies with Signal Recall > 0.7 and Filter Accuracy > 0.65 capture opportunities reliably without destroying edge through over-filtering.

**3. Which strategies generate too many false positives?**
Strategies with precision < 0.45 after cost adjustment generate too many false positives. The dashboard explicitly surfaces these.

**4. Which filters improve results?**
Per Phase 11 analysis: TREND_FILTER (+7% precision, −12% recall) and REGIME_FILTER (+6% precision, −10% recall) show the highest incremental value. VOLUME_FILTER (+5% precision, −8% recall) is also high-value. These estimates will be refined as sample sizes grow.

**5. Does ML add measurable value?**
The ML layer (regime classifier + stock ranker) is expected to add 2–6 percentage points of precision, primarily through the quant pre-filter (ADX/relVol/ATR%) and the ML rank boost (±0.06 confidence). The `mlAddsMeasurableValue` flag in the live report shows whether this threshold has been crossed for each strategy in the current window.

**6. Are confidence scores trustworthy?**
The reliability diagram on the dashboard shows the current ECE. An ECE < 0.05 indicates the confidence system is well-calibrated. The system also tracks whether the S/A/B/C/D grade ordering holds — a necessary condition for confidence scores to be operationally useful.

**7. Which market regimes are profitable?**
From the regime heatmap: most intraday trend strategies are expected to underperform in RANGE_BOUND and HIGH_VOLATILITY regimes. EXPIRY_DAY (Thursday) tends to produce mean-reversion setups that benefit PCR_EXTREME, MAX_PAIN_GRAVITY, and LIQUIDITY_EDGE but are hostile to RANGE_EXPANSION and EMA_PULLBACK.

**8. Which instruments should be preferred?**
High-liquidity F&O indices (NIFTY, BANKNIFTY) consistently have lower slippage sensitivity and more stable signal quality than individual stocks. The instrument heatmap identifies specific stocks to prefer or avoid based on precision and expectancy.

**9. Which times of day should be avoided?**
Based on structural NSE market behaviour:
- **09:15–09:30:** High false signal rate due to opening volatility — CAUTION
- **12:00–13:00:** Lunch lull, low volume — CAUTION for new entries
- **15:00–15:30:** Square-off pressure, stop-hunting common — AVOID new entries
- **10:00–11:00:** Strongest signal quality window for most strategies — TRADE

**10. Which strategies should move forward to the AlphaForge governance pipeline?**

Strategies are eligible for the governance pipeline when:
1. Verdict is `HIGH_QUALITY` (score ≥ 75, n ≥ 30)
2. Cost robustness is `COST_ROBUST` or `COST_SENSITIVE` (not `COST_FRAGILE`)
3. Confidence calibration assessment is `WELL_CALIBRATED` or `ACCEPTABLE`
4. Grade system ordering is valid (S ≥ A ≥ B ≥ C ≥ D)

Strategies classified as `NEEDS_MORE_DATA` should accumulate paper-trade history before any governance decision is made.

---

## Implementation Files

### Backend Engine

| File | Description |
|------|-------------|
| `src/lib/signal-quality/types.ts` | All TypeScript types for Phases 1–22 |
| `src/lib/signal-quality/stats.ts` | Statistical utilities: mean, stdDev, percentile, bootstrap CI, Brier score, ECE |
| `src/lib/signal-quality/ground-truth.ts` | Immutable strategy ground-truth definitions (pre-defined before any calculation) |
| `src/lib/signal-quality/engine.ts` | Full 20-phase evaluation engine; reads from Prisma; returns `SignalQualityReport` |
| `src/lib/signal-quality/index.ts` | Public re-exports |

### API Route

| File | Route | Description |
|------|-------|-------------|
| `src/app/api/in/signal-quality/route.ts` | `GET /api/in/signal-quality?window=N` | Runs evaluation engine; 5-minute cache; returns `SignalQualityReport` JSON |

### Frontend Components

All in `src/components/india/signal-quality/`:

| Component | Phase |
|-----------|-------|
| `verdict-badge.tsx` | Cross-cutting |
| `headline-metrics.tsx` | Overview |
| `strategy-leaderboard.tsx` | Phase 10 |
| `confusion-matrix-card.tsx` | Phase 2 |
| `calibration-chart.tsx` | Phases 7 & 8 |
| `regime-heatmap.tsx` | Phase 14 |
| `time-of-day-heatmap.tsx` | Phase 16 |
| `mfe-mae-card.tsx` | Phase 6 |
| `grade-validation-card.tsx` | Phase 9 |
| `paper-signal-funnel.tsx` | Phase 17 |
| `signal-quality-score-card.tsx` | Phase 20 |
| `cost-robustness-card.tsx` | Phase 18 |
| `instrument-heatmap.tsx` | Phase 15 |
| `final-verdicts-panel.tsx` | Final Verdict |

### Dashboard Page

| File | Route |
|------|-------|
| `src/app/(dashboard)/in/signal-quality/page.tsx` | `/in/signal-quality` |

---

## Known Limitations and Future Work

| Limitation | Current State | Path to Resolution |
|------------|--------------|-------------------|
| FN/TN are estimated (not exact) | Conservatively approximated as 20% miss rate | Deploy independent opportunity scanner; compare against strategy condition replay on `CandleBar` data |
| MFE/MAE are proxied (not exact) | Derived from exit prices using statistical proxies | Implement candle-by-candle replay module reading from `CandleBar` table |
| Regime labels are inferred from meta | Best-effort heuristic from trade metadata | Store regime label at signal generation time; persist in `PaperTrade.meta` |
| Forward return horizons 1m/5m/15m/30m/60m | Not yet implemented (requires tick replay) | Wire up `CandleBar` replay for each resolved trade |
| Filter ablation uses estimated impacts | Not yet measured from live data | Persist filter decision at signal generation time to enable exact ablation |
| ML contribution uses meta.extras.mlEnhanced | Only available for AI Signal trades | Add `mlEnhanced` flag to all paper-trade meta at generation time |
| Bootstrap CI uses `Math.random()` | Not deterministic | Use a seeded PRNG for reproducible CI bounds in regression tests |

---

## Governance Recommendation

### Strategies Ready for Governance Pipeline

_(To be populated from live report data as sample sizes grow to n ≥ 30.)_

Live classification is available at `/in/signal-quality` → Final Verdicts panel.

### Strategies Requiring More Data

All strategies with `sampleSize < 15` receive verdict `NEEDS_MORE_DATA` regardless of score.

The paper-trading auto-trader (`AutoTradingDashboard`) is the primary source of resolved trades. Ensuring the auto-trader remains active during NSE market hours is the critical path to gathering sufficient sample sizes for all strategies.

### Strategies Under Review

Strategies with verdict `DEGRADED` or `DISABLE_CANDIDATE` should be reviewed against:
1. Parameter configuration (SL/target/entry zone sizing)
2. Regime gate settings (are they firing in hostile regimes?)
3. ML filter thresholds (is the confidence penalty too aggressive?)
4. Time-of-day restrictions (are they generating signals in poor slots?)

**No strategy should be disabled without first achieving n ≥ 30 resolved trades.** A low-sample verdict may reverse completely with more data.

---

*Generated by AlphaForge Signal Quality Engine v1.0*
*Source: `src/lib/signal-quality/engine.ts`*
*Dashboard: `/in/signal-quality`*
*API: `GET /api/in/signal-quality`*
